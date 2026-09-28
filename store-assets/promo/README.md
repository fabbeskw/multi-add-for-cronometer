# Store assets: promo tiles

Two Chrome Web Store promotional images, **committed** (unlike the screenshots one folder up, they contain no
account data: they are drawn from shapes and text only, with no screenshot and no diary content):

| File | Size | Store status | Upload to |
|---|---|---|---|
| `small-promo-440x280.png` | 440 x 280, 24-bit RGB PNG, opaque | **Required.** "Only the extension icon, a small promotional image, and a screenshot are mandatory." Without it an item is shown after items that have one. | Store listing tab, *Small promo tile* |
| `marquee-1400x560.png` | 1400 x 560, 24-bit RGB PNG, opaque | Optional. Used only if the item is picked for the marquee carousel on the store home page. | Store listing tab, *Marquee promo tile* |

The store icon is `icons/icon128.png` (inside the package; the dashboard shows it from the zip). It follows the
store's icon guidance: 96 x 96 artwork centred on the 128 x 128 canvas with 16 px of fully transparent padding
per side, so it does not look oversized next to other items. It works on light and dark backgrounds, and it has no
border and no large drop shadow.

Source for the rules: <https://developer.chrome.com/docs/webstore/images>. The tiles follow its promo guidance:
they fill the whole region with saturated colour rather than mostly white or light grey, have well-defined edges,
use little text that stays readable at half size, are not a screenshot, and make no status claims.

## What they show

* The extension icon: a teal rounded square with a white list of three rows and a "+" ("add many"). It is original
  art with no Cronometer logo, wordmark or brand colour.
* The name **Multi-Add for Cronometer**.
* One subject with its two functions (matching the single-purpose statement): the small tile says **Faster diary
  logging:** with the bullets **a whole meal at once** and **adaptive TDEE from your log**; the marquee says
  **Faster diary logging · adaptive TDEE**.
* **Unofficial — not affiliated with Cronometer** in small type (the store's impersonation / IP policy: don't
  imply endorsement).
* The marquee also has an abstract illustration: a list card with ticked rows and an add button, and a small trend
  chart. It uses shapes only, so it is neither a screenshot nor Cronometer's UI.

Promo images are not localised and go through their own review. A new image can sit in *Pending review* for up to
about a week after upload.

## Regenerating

The sources of record are in `graphics/`: `icon-16.svg`, `icon-32.svg`, `icon-48.svg`, `icon-128.svg`,
`promo-small.html`, `marquee.html`, `promo.css`, and `preview.html` (a contact sheet, not store material).
`tools/make_graphics.py` renders them with headless Chrome through the DevTools pipe (`tools/cdp.py`). For each
file it sets the exact output size (device scale factor 1), gives the icons a transparent background and the tiles
an opaque one, captures a PNG, re-encodes it deterministically and verifies it:

```
python tools/make_graphics.py                     # render + verify everything (icons/*.png and these two tiles)
python tools/make_graphics.py --only promo        # only the tiles (or: icons, or one file name)
python tools/make_graphics.py --verify            # no Chrome: sizes, colour types, transparent corners, 16 px padding
python tools/make_graphics.py --check             # render into a temp folder and compare pixels with the committed files
python tools/make_graphics.py --preview sheet.png # plus a contact sheet: icons at 1x and magnified on light/dark, tiles at full/half size
```

Checks after every render:

* The IHDR size matches the target.
* Icons are RGBA with four fully transparent corners and an opaque centre. For `icon128.png`, every pixel in the
  16 px padding is fully transparent.
* Tiles are RGB with no alpha, and they are not blank.
* On each tile, every text block lies inside the tile without clipping, and every image loaded.

Text uses the system font stack in `graphics/promo.css` (Segoe UI on Windows, Helvetica Neue / Helvetica
elsewhere). The committed tiles were rendered on Windows, so a render on another OS can differ by a few pixels of
text, and `--check` would then report a difference. That is expected, not a defect.
