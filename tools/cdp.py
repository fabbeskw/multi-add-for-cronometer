#!/usr/bin/env python3
"""cdp.py - a minimal Chrome DevTools Protocol client over --remote-debugging-pipe (Python 3, stdlib only).

Shared by tools/smoke_extension.py (headless install check) and tools/screenshots.py (store screenshots):

    from cdp import Cdp, find_chrome
    cdp = Cdp(chrome, profile_dir, stderr_path)                  # headless, about:blank (smoke_extension.py)
    cdp = Cdp(chrome, profile_dir, stderr_path, headless=False,  # a visible window (screenshots.py)
              window_size=(1280, 800), extra_args=['--hide-crash-restore-bubble'])
    v = cdp.call('Browser.getVersion')                            # -> the raw reply {'id', 'result'} or {'error': {...}}
    r = cdp.call('Extensions.loadUnpacked', {'path': ext_dir}, timeout=60)
    s = cdp.call('Target.attachToTarget', {'targetId': tid, 'flatten': True})['result']['sessionId']
    cdp.call('Runtime.evaluate', {'expression': '1+1', 'returnByValue': True}, session_id=s)
    ev = cdp.wait_event('Page.loadEventFired', session_id=s, timeout=30)   # consumes the first matching event
    cdp.on('Runtime.executionContextCreated', handler)            # handler(message) on the reader thread
    cdp.close()                                                   # Browser.close, then wait / kill

Why the pipe and not --remote-debugging-port: Google Chrome 137+ (the branded build) ignores --load-extension,
and its supported replacement, the DevTools command Extensions.loadUnpacked, is offered ONLY to a client
connected through --remote-debugging-pipe while --enable-unsafe-extension-debugging is set (see
tools/smoke_extension.py, which measured this on Chrome 150). Transport: JSON messages separated by NUL bytes;
on Windows the pipe ends are inheritable handles named by --remote-debugging-io-pipes=<read>,<write>, on
macOS/Linux they are file descriptors 3 and 4. Chrome exits when its end of the pipe closes, so the client
must stay alive for as long as the browser should.

Replies are matched by id; every other message is an event, kept in a bounded queue for wait_event()/events()
and handed to the handlers registered with on(). A reply never comes back as {'error': {'message': ...}}
synthesized by this class only for a timeout, a closed pipe or a failed write (the same shape Chrome uses for
a protocol error, so callers test 'error' in reply once). A call() that gives up (timeout, closed pipe, Ctrl+C)
forgets its id, so a reply arriving later is dropped instead of piling up; send() loops until the whole message is
written; a Chrome that fails to start leaves no open pipe end or stderr file behind.
"""
import collections
import json
import os
import subprocess
import threading
import time

CHROME_CANDIDATES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    os.path.join(os.environ.get('LOCALAPPDATA', ''), r'Google\Chrome\Application\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]
MAX_PARKED_EVENTS = 20000     # events nobody consumed (Runtime.consoleAPICalled floods on a busy page)


def find_chrome(explicit=None):
    """The first existing Chrome binary among: the explicit path, $CHROME, the usual install locations."""
    candidates = ([explicit] if explicit else []) + ([os.environ.get('CHROME')] if os.environ.get('CHROME') else []) + CHROME_CANDIDATES
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


class Cdp:
    """A DevTools-protocol client that launches Chrome itself and talks to it over the debugging pipe."""

    def __init__(self, chrome, profile, stderr_path, headless=True, url='about:blank', extra_args=None, window_size=None):
        self._replies = {}
        self._abandoned = set()             # ids whose call() gave up (timeout, closed pipe, Ctrl+C): replies dropped
        self._events = collections.deque()
        self._event_seq = 0
        self._handlers = collections.defaultdict(list)
        self._cv = threading.Condition()
        self._closed = False
        self._stderr = None
        self.next_id = 0
        # python -> chrome: chrome reads r_chrome; chrome -> python: chrome writes w_chrome
        r_chrome, w_py = os.pipe()
        r_py, w_chrome = os.pipe()
        try:
            args = [chrome]
            if headless:
                # exactly the flags tools/smoke_extension.py used before the client was factored out
                args += ['--headless=new', '--disable-gpu', '--no-sandbox']
            args += ['--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging', '--remote-debugging-pipe']
            if window_size:
                args.append('--window-size=%d,%d' % (int(window_size[0]), int(window_size[1])))
            args += list(extra_args or [])
            args += ['--user-data-dir=' + profile, url]
            self._stderr = open(stderr_path, 'wb')
            popen_kw = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': self._stderr}
            if os.name == 'nt':
                import msvcrt
                h_read, h_write = msvcrt.get_osfhandle(r_chrome), msvcrt.get_osfhandle(w_chrome)
                os.set_handle_inheritable(h_read, True)
                os.set_handle_inheritable(h_write, True)
                args.insert(-2, '--remote-debugging-io-pipes=%d,%d' % (h_read, h_write))
                popen_kw['close_fds'] = False
            else:
                def child():                       # runs in the child after fork: the pipe ends become fds 3 and 4
                    a, b = os.dup(r_chrome), os.dup(w_chrome)
                    os.dup2(a, 3)
                    os.dup2(b, 4)
                popen_kw['preexec_fn'] = child
                popen_kw['pass_fds'] = (r_chrome, w_chrome)
            self.cmd = args
            self.proc = subprocess.Popen(args, **popen_kw)
        except BaseException:
            # Chrome did not start (a bad path, no permission, Ctrl+C): release all four pipe ends and the stderr
            # file, which nothing else would ever close, so the caller can delete the profile directory.
            for fd in (r_chrome, w_chrome, r_py, w_py):
                try:
                    os.close(fd)
                except OSError:
                    pass
            if self._stderr is not None:
                try:
                    self._stderr.close()
                except OSError:
                    pass
            raise
        os.close(r_chrome)
        os.close(w_chrome)
        self.out = os.fdopen(w_py, 'wb', 0)
        self.inp = os.fdopen(r_py, 'rb', 0)
        self._write_lock = threading.Lock()
        self._reader_thread = threading.Thread(target=self._reader, daemon=True)
        self._reader_thread.start()

    # ------------------------------------------------------------------ transport
    def _reader(self):
        buf = b''
        while True:
            try:
                chunk = self.inp.read(65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b'\0' in buf:
                raw, buf = buf.split(b'\0', 1)
                try:
                    m = json.loads(raw.decode('utf-8'))
                except ValueError:
                    continue
                self._dispatch(m)
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    def _dispatch(self, m):
        if 'id' in m:
            with self._cv:
                if m['id'] in self._abandoned:     # its call() already returned an error: do not keep the reply
                    self._abandoned.discard(m['id'])
                    return
                self._replies[m['id']] = m
                self._cv.notify_all()
            return
        with self._cv:
            self._event_seq += 1
            m['_seq'] = self._event_seq
            self._events.append(m)
            while len(self._events) > MAX_PARKED_EVENTS:
                self._events.popleft()
            self._cv.notify_all()
        for h in list(self._handlers.get(m.get('method'), [])) + list(self._handlers.get('*', [])):
            try:
                h(m)
            except Exception:              # a handler must never kill the reader
                pass

    def alive(self):
        return not self._closed and self.proc.poll() is None

    def send(self, method, params=None, session_id=None):
        """Send a command without waiting; returns the message id, or None when the pipe is unusable."""
        with self._write_lock:
            self.next_id += 1
            mid = self.next_id
            msg = {'id': mid, 'method': method, 'params': params or {}}
            if session_id:
                msg['sessionId'] = session_id
            data = memoryview((json.dumps(msg) + '\0').encode('utf-8'))
            try:
                # an unbuffered pipe write may be partial (a large Runtime.evaluate source): write the rest until
                # every byte is out, otherwise Chrome would read a truncated message glued to the next one
                while len(data):
                    n = self.out.write(data)
                    data = data[n or 0:]
            except OSError:
                return None
        return mid

    def call(self, method, params=None, timeout=20, session_id=None):
        """Send a command and return its reply ({'id', 'result'} or {'id', 'error'}); a timeout, a closed pipe or a
        failed write come back as {'error': {'message': ...}} so callers test 'error' in reply once."""
        mid = self.send(method, params, session_id)
        if mid is None:
            return {'error': {'message': 'pipe write failed for %s' % method}}
        deadline = time.time() + timeout
        answered = False
        try:
            with self._cv:
                while mid not in self._replies:
                    if self._closed:
                        return {'error': {'message': 'DevTools pipe closed'}}
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        return {'error': {'message': 'timeout after %gs waiting for %s' % (timeout, method)}}
                    self._cv.wait(remaining)
                answered = True
                return self._replies.pop(mid)
        finally:
            if not answered:
                # timeout / closed pipe / KeyboardInterrupt: a late reply for this id must not pile up in _replies
                with self._cv:
                    if self._replies.pop(mid, None) is None:
                        self._abandoned.add(mid)

    # ------------------------------------------------------------------ events
    def on(self, method, handler):
        """Register handler(message) for an event method ('*' = every event). Runs on the reader thread."""
        self._handlers[method].append(handler)

    def events(self, method=None, session_id=None, consume=False):
        """The parked events (optionally filtered); consume=True removes the returned ones."""
        with self._cv:
            out = [m for m in self._events
                   if (method is None or m.get('method') == method) and (session_id is None or m.get('sessionId') == session_id)]
            if consume:
                for m in out:
                    self._events.remove(m)
        return out

    def wait_event(self, method, pred=None, timeout=20, session_id=None):
        """Remove and return the first parked event that matches (method, session, pred(params)), waiting up to
        timeout seconds for one to arrive; None on timeout or when the pipe closed."""
        deadline = time.time() + timeout
        with self._cv:
            while True:
                for m in self._events:
                    if m.get('method') != method:
                        continue
                    if session_id is not None and m.get('sessionId') != session_id:
                        continue
                    if pred is not None:
                        try:
                            if not pred(m.get('params') or {}):
                                continue
                        except Exception:
                            continue
                    self._events.remove(m)
                    return m
                if self._closed:
                    return None
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self._cv.wait(remaining)

    def drain(self, method=None):
        """Forget the parked events (all, or those of one method)."""
        with self._cv:
            if method is None:
                self._events.clear()
            else:
                for m in [m for m in self._events if m.get('method') == method]:
                    self._events.remove(m)

    # ------------------------------------------------------------------ shutdown
    def close(self, grace_s=15):
        """Ask the browser to close, wait, kill what is left, release the pipe and the stderr file."""
        if self.proc.poll() is None:
            self.call('Browser.close', timeout=5)
            try:
                self.proc.wait(timeout=grace_s)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        for f in (self.out, self.inp, self._stderr):
            if f is None:
                continue
            try:
                f.close()
            except OSError:
                pass
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    def kill(self):
        """Terminate Chrome without the Browser.close handshake (Ctrl+C paths)."""
        if self.proc.poll() is None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                pass
        self.close(grace_s=1)
