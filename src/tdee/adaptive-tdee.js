/* src/tdee/adaptive-tdee.js - generated - do not edit; regenerate with python tools/gen_tdee.py
 *
 * Source : vendor/adaptive-tdee/adaptive-tdee.js (pristine upstream Adaptive TDEE engine; its maths is fixed)
 * SHA-256: 62928423307b610ce012da7b397b570e0b51f8e8521cc1d88ef70d2b9ad67e21 (upstream text, LF line endings)
 *
 * The upstream ES module as a classic content script (SPEC 0). The text between the upstream markers is the
 * upstream file with only the column-0 "export" keywords (and the space after them) removed;
 * tests/tdee.html proves it against the vendor copy. To update the engine: replace the vendor files, run
 * python tools/gen_tdee.py, run the suite.
 */
window.CMA = window.CMA || {};
(function () {
'use strict';
/*<upstream>*/
/**
 * adaptive-tdee.js — MacroFactor-style adaptive expenditure (TDEE) engine.
 *
 * Reference implementation for the Cronometer extension. Pure functions, no
 * dependencies, no DOM, no chrome.* APIs, so it runs in a service worker, a
 * content script, a popup, or Node (for tests).
 *
 * Core idea (same premise MacroFactor publishes):
 *   expenditure = calories in − change in stored energy
 *   change in stored energy = change in *trend* weight × 7700 kcal/kg
 *
 * Implementation: a 3-state Kalman filter run once per day.
 *   W  — tissue weight in kg (fat + lean; changes only via energy balance)
 *   E  — average daily energy expenditure in kcal/day (the adaptive TDEE)
 *   H  — short-lived water offset in kg (salty meal, hard session, cycle), mean-reverting
 * plus a deterministic glycogen/gut term G = γ·(recent intake − E), so the drop on
 * starting a cut (or the jump on starting a bulk) isn't mistaken for an expenditure change.
 * Scale weight is modelled as W + G + H + noise; the trend weight shown to users is W + G.
 *
 * Each day it PREDICTS this morning's weight from yesterday's logged intake and the
 * current expenditure estimate, COMPARES that with the scale, and nudges E by an amount
 * proportional to how surprised it was and how confident it already is — the
 * predict → observe → update loop MacroFactor describes. That gives, without special
 * cases: missing weigh-ins, fast early calibration that slows as confidence builds,
 * damping of 1–5 day water spikes, and a ± confidence band.
 */

/** User-facing "responsiveness" setting → expenditureDriftKcal. */
const RESPONSIVENESS = Object.freeze({ stable: 10, balanced: 15, responsive: 25 });

const DEFAULT_CONFIG = Object.freeze({
  kcalPerKg: 7700,             // symmetric for gain and loss (MacroFactor V3 fix; ≈3500 kcal/lb)
  priorSdKcal: 400,            // how wrong the starting estimate might be (1 SD)
  expenditureDriftKcal: 15,    // SD of real day-to-day drift in expenditure → responsiveness vs stability knob
  waterSdFrac: 0.006,          // stationary SD of water/glycogen swings as a fraction of body weight
  waterTauDays: 3,             // how many days a water swing typically lingers
  scaleSdFrac: 0.003,          // pure day-to-day scale noise as a fraction of body weight
  tissueSdKg: 0.01,            // per-day process noise on tissue weight
  loggedIntakeSdFrac: 0.10,    // random error on a logged day's calories
  imputedIntakeSdFrac: 0.35,   // error when a missing day's calories are imputed
  imputeLookbackDays: 14,      // imputation uses the mean of logged days in this window
  statusWindowDays: 7,
  holdMinNutritionDays: 4,     // need ≥4 logged days in the previous 7 or E is frozen ("holding")
  holdMinWeighIns: 1,          // need ≥1 weigh-in in the trailing 7 or E is frozen
  warmupDays: 7,               // E is frozen for the first N days (initial estimate "sticks around")
  calibratedSdKcal: 150,       // below this SD (and after calibrationMinDays of updating) we call it calibrated
  calibrationMinDays: 14,
  outlierSigma: 4,             // weigh-ins more than N SD from prediction are ignored (typos, 85 vs 58)
  // Glycogen / gut-content term: being in a deficit lowers scale weight by more than the fat
  // lost (less glycogen + water + food in the gut); a surplus does the opposite. Without this,
  // starting a cut makes the model think expenditure jumped, and starting a bulk makes it think
  // expenditure fell. Set glycogenKgPerKcal to 0 to disable.
  glycogenKgPerKcal: 0.0015,   // kg of non-tissue weight per kcal/day of energy balance (≈0.8 kg at −550/day)
  glycogenTauDays: 4,          // how quickly glycogen/gut content follows intake
  glycogenMaxFrac: 0.015,      // cap on that offset as a fraction of body weight
});

// ---------------------------------------------------------------------------
// Date helpers (UTC-based ISO dates; the diary day is the unit, never a timestamp)
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;
const toUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
function addDays(iso, n) { return toIso(toUtc(iso) + n * DAY_MS); }
function daysBetween(a, b) { return Math.round((toUtc(b) - toUtc(a)) / DAY_MS); }

/**
 * Normalise raw records into one entry per calendar day, filling gaps with nulls.
 * @param {Array<{date:string, intakeKcal?:number|null, weightKg?:number|null,
 *                burnedKcal?:number|null, excluded?:boolean}>} records
 */
function normaliseDays(records) {
  if (!records.length) return [];
  const byDate = new Map();
  for (const r of records) {
    const cur = byDate.get(r.date) || { date: r.date, intakeKcal: null, weightKg: null, burnedKcal: null, excluded: false };
    if (r.intakeKcal != null && Number.isFinite(r.intakeKcal)) cur.intakeKcal = r.intakeKcal;
    if (r.weightKg != null && Number.isFinite(r.weightKg) && cur.weightKg == null) cur.weightKg = r.weightKg; // first weigh-in of the day wins
    if (r.burnedKcal != null && Number.isFinite(r.burnedKcal)) cur.burnedKcal = r.burnedKcal;
    if (r.excluded) cur.excluded = true;
    byDate.set(r.date, cur);
  }
  const dates = [...byDate.keys()].sort();
  const out = [];
  for (let d = dates[0]; d <= dates[dates.length - 1]; d = addDays(d, 1)) {
    out.push(byDate.get(d) || { date: d, intakeKcal: null, weightKg: null, burnedKcal: null, excluded: false });
  }
  // An excluded day (user flagged as partially logged) counts as a missing nutrition day.
  for (const d of out) if (d.excluded) d.intakeKcal = null;
  return out;
}

// ---------------------------------------------------------------------------
// Tiny 3×3 linear algebra
// ---------------------------------------------------------------------------
const mat = () => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
function mul(A, B) {
  const C = mat();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j]; C[i][j] = s;
  }
  return C;
}
const tr = (A) => A[0].map((_, j) => A.map((row) => row[j]));

// ---------------------------------------------------------------------------
// Main model
// ---------------------------------------------------------------------------
/**
 * Run the expenditure model over the full history. Deterministic: same input → same output,
 * so it is safe to recompute from scratch whenever data changes (a year of data is ~365 tiny steps).
 *
 * @param {Array} records  see normaliseDays()
 * @param {object} [opts]
 * @param {number} [opts.initialExpenditureKcal]  manual starting estimate; otherwise the mean of
 *                 Cronometer's "burned" over the first 7 days that have it.
 * @param {object} [opts.config]  overrides for DEFAULT_CONFIG
 * @returns {{days: Array, current: object|null}}
 */
function runExpenditureModel(records, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const days = normaliseDays(records);
  const startIdx = days.findIndex((d) => d.weightKg != null);
  if (startIdx < 0) return { days: [], current: null, error: 'NO_WEIGHT_DATA' };

  // --- Prior (initial estimate) -------------------------------------------
  let prior = opts.initialExpenditureKcal;
  let priorSource = 'manual';
  if (prior == null) {
    const burned = days.slice(startIdx).map((d) => d.burnedKcal).filter((v) => v != null).slice(0, 7);
    if (burned.length) { prior = burned.reduce((a, b) => a + b, 0) / burned.length; priorSource = 'cronometer'; }
  }
  if (prior == null) {
    const intake = days.slice(startIdx).map((d) => d.intakeKcal).filter((v) => v != null).slice(0, 14);
    if (intake.length) { prior = intake.reduce((a, b) => a + b, 0) / intake.length; priorSource = 'intake'; }
  }
  if (prior == null) return { days: [], current: null, error: 'NO_PRIOR' };

  const rho = cfg.kcalPerKg;
  const phi = Math.exp(-1 / cfg.waterTauDays);
  const psi = Math.exp(-1 / cfg.glycogenTauDays);
  const gamma = cfg.glycogenKgPerKcal;

  // --- State ----------------------------------------------------------------
  const w0 = days[startIdx].weightKg;
  let x = [w0, prior, 0];
  let P = [[4, 0, 0], [0, cfg.priorSdKcal ** 2, 0], [0, 0, (cfg.waterSdFrac * w0) ** 2]];
  // Smoothed recent intake that drives the glycogen/gut term. Start assuming energy balance.
  let intakeEma = prior;

  const out = [];
  let updatingDays = 0;

  for (let i = startIdx; i < days.length; i++) {
    const d = days[i];
    const dayIndex = i - startIdx;

    // --- Status for today (trailing window) ---------------------------------
    // Nutrition: the 7 days BEFORE today (this morning's weight reflects intake up to last night,
    // and today's diary is still incomplete). Weigh-ins: the 7 days ending today.
    const n = cfg.statusWindowDays;
    const nLo = Math.max(startIdx, i - n);
    const wLo = Math.max(startIdx, i - n + 1);
    let nutritionDays = 0, weighIns = 0;
    for (let j = nLo; j < i; j++) if (days[j].intakeKcal != null) nutritionDays++;
    for (let j = wLo; j <= i; j++) if (days[j].weightKg != null) weighIns++;
    // Early on the window is shorter than 7 days; scale the requirement.
    const needNutrition = Math.ceil(cfg.holdMinNutritionDays * (i - nLo) / n);
    let status;
    if (dayIndex < cfg.warmupDays) status = 'warmup';
    else if (nutritionDays < needNutrition || weighIns < cfg.holdMinWeighIns) status = 'holding';
    else status = 'updating';
    const freezeE = status !== 'updating';

    // --- Glycogen/gut offset G = gamma × (recent intake − expenditure), capped ---
    // Linear in E, so it enters the observation row as −gamma on the E state.
    const gCap = cfg.glycogenMaxFrac * x[0];
    let gRaw = gamma * (intakeEma - x[1]);
    const gCapped = Math.abs(gRaw) > gCap;
    const G = gCapped ? Math.sign(gRaw) * gCap : gRaw;
    const h = [1, gCapped ? 0 : -gamma, 1]; // observation row: y = W + G(E) + H + noise

    // --- Measurement update: this morning's weigh-in -------------------------
    let outlier = false;
    if (d.weightKg != null) {
      const R = (cfg.scaleSdFrac * x[0]) ** 2;
      const Ph = [0, 1, 2].map((a) => P[a][0] * h[0] + P[a][1] * h[1] + P[a][2] * h[2]);
      const S = h[0] * Ph[0] + h[1] * Ph[1] + h[2] * Ph[2] + R;
      const innov = d.weightKg - (x[0] + G + x[2]);
      if (Math.abs(innov) > cfg.outlierSigma * Math.sqrt(S)) {
        outlier = true;
      } else {
        const K = Ph.map((v) => v / S);
        if (freezeE) K[1] = 0;
        for (let k = 0; k < 3; k++) x[k] += K[k] * innov;
        // Joseph form: stays valid even when we zero part of the gain.
        const IKH = [0, 1, 2].map((a) => [0, 1, 2].map((b) => (a === b ? 1 : 0) - K[a] * h[b]));
        P = mul(mul(IKH, P), tr(IKH));
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) P[a][b] += K[a] * K[b] * R;
      }
    }

    if (status === 'updating') updatingDays++;
    const sd = Math.sqrt(P[1][1]);
    const gNow = Math.max(-gCap, Math.min(gCap, gamma * (intakeEma - x[1])));

    // --- Intake for today (logged or imputed) --------------------------------
    let intake = d.intakeKcal;
    let imputed = false;
    if (intake == null) {
      const lb = Math.max(startIdx, i - cfg.imputeLookbackDays);
      const logged = [];
      for (let j = lb; j < i; j++) if (days[j].intakeKcal != null) logged.push(days[j].intakeKcal);
      intake = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : x[1];
      imputed = true;
    }

    out.push({
      date: d.date,
      scaleWeightKg: d.weightKg,
      // Trend weight = what the scale would read without short-lived water noise.
      trendWeightKg: round(x[0] + gNow, 2),
      tissueWeightKg: round(x[0], 2),
      glycogenOffsetKg: round(gNow, 2),
      waterOffsetKg: round(x[2], 2),
      expenditureKcal: Math.round(x[1]),
      expenditureSdKcal: Math.round(sd),
      status,
      calibrated: updatingDays >= cfg.calibrationMinDays && sd <= cfg.calibratedSdKcal,
      intakeKcal: d.intakeKcal,
      intakeUsedKcal: Math.round(intake),
      intakeImputed: imputed,
      cronometerBurnedKcal: d.burnedKcal,
      weightOutlier: outlier,
      nutritionDaysPrev7: nutritionDays,
      weighInsLast7: weighIns,
    });

    // --- Predict to tomorrow morning ----------------------------------------
    const F = [[1, -1 / rho, 0], [0, 1, 0], [0, 0, phi]];
    x = [x[0] + (intake - x[1]) / rho, x[1], phi * x[2]];
    intakeEma = psi * intakeEma + (1 - psi) * intake;
    const intakeSd = (imputed ? cfg.imputedIntakeSdFrac : cfg.loggedIntakeSdFrac) * intake / rho;
    const waterSd = cfg.waterSdFrac * x[0];
    const Q = [
      [cfg.tissueSdKg ** 2 + intakeSd ** 2, 0, 0],
      [0, freezeE ? 0 : cfg.expenditureDriftKcal ** 2, 0],
      [0, 0, waterSd ** 2 * (1 - phi * phi)],
    ];
    P = mul(mul(F, P), tr(F));
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) P[a][b] += Q[a][b];
  }

  const last = out[out.length - 1];
  const tail = (n, key) => {
    const v = out.slice(-n).map((o) => o[key]).filter((z) => z != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const burned14 = tail(14, 'cronometerBurnedKcal');
  const current = {
    date: last.date,
    expenditureKcal: last.expenditureKcal,
    expenditureSdKcal: last.expenditureSdKcal,
    trendWeightKg: last.trendWeightKg,
    status: last.status,
    calibrated: last.calibrated,
    priorKcal: Math.round(prior),
    priorSource,
    // Trend weight change per week, from the last 7 days of the filter's trend.
    weeklyTrendChangeKg: out.length >= 8 ? round(last.trendWeightKg - out[out.length - 8].trendWeightKg, 2) : null,
    avgIntake7Kcal: roundOrNull(tail(7, 'intakeKcal')),
    cronometerBurned14Kcal: roundOrNull(burned14),
    // >1 means your real burn is higher than Cronometer estimates; <1 means Cronometer overestimates.
    cronometerCalibrationRatio: burned14 ? round(last.expenditureKcal / burned14, 3) : null,
  };
  return { days: out, current };
}

// ---------------------------------------------------------------------------
// Weekly check-in: expenditure + goal → calorie & macro targets
// ---------------------------------------------------------------------------
const DEFAULT_CHECKIN = Object.freeze({
  kcalPerKg: 7700,
  maxLossPctPerWeek: 1.0,
  maxGainPctPerWeek: 0.5,
  minKcal: { female: 1200, male: 1500, other: 1350 },
  maxWeeklyChangeKcal: 250,       // only applied once calibrated and goal unchanged
  proteinGPerKg: 1.8,
  fatFloorGPerKg: 0.6,
  fatShareOfRemaining: 0.35,      // share of non-protein calories from fat (≈ "balanced")
  roundTo: 10,
});

/**
 * @param {object} p
 * @param {{expenditureKcal:number, trendWeightKg:number, calibrated:boolean, status:string}} p.model  runExpenditureModel().current
 * @param {{ratePctPerWeek:number}} p.goal  negative = lose, 0 = maintain, positive = gain (% of body weight per week)
 * @param {'female'|'male'|'other'} [p.sex]
 * @param {number|null} [p.previousTargetKcal]
 * @param {boolean} [p.goalChanged]
 * @param {object} [p.settings]  overrides for DEFAULT_CHECKIN
 */
function weeklyCheckIn({ model, goal, sex = 'other', previousTargetKcal = null, goalChanged = false, settings = {} }) {
  const s = { ...DEFAULT_CHECKIN, ...settings, minKcal: { ...DEFAULT_CHECKIN.minKcal, ...(settings.minKcal || {}) } };
  const notes = [];
  const W = model.trendWeightKg;

  let rate = goal.ratePctPerWeek;
  if (rate < -s.maxLossPctPerWeek) { rate = -s.maxLossPctPerWeek; notes.push(`Loss rate capped at ${s.maxLossPctPerWeek}%/week.`); }
  if (rate > s.maxGainPctPerWeek) { rate = s.maxGainPctPerWeek; notes.push(`Gain rate capped at ${s.maxGainPctPerWeek}%/week.`); }

  const energyDelta = (rate / 100) * W * s.kcalPerKg / 7; // kcal/day surplus (+) or deficit (−)
  let target = model.expenditureKcal + energyDelta;

  if (previousTargetKcal != null && model.calibrated && !goalChanged) {
    const change = target - previousTargetKcal;
    if (Math.abs(change) > s.maxWeeklyChangeKcal) {
      target = previousTargetKcal + Math.sign(change) * s.maxWeeklyChangeKcal;
      notes.push(`Weekly change limited to ±${s.maxWeeklyChangeKcal} kcal; the rest will follow next week if the trend holds.`);
    }
  }
  const floor = s.minKcal[sex] ?? s.minKcal.other;
  if (target < floor) { target = floor; notes.push(`Target raised to the ${floor} kcal minimum.`); }
  if (model.status !== 'updating') notes.push(`Expenditure is ${model.status}; this target is based on the last confident estimate.`);

  target = Math.round(target / s.roundTo) * s.roundTo;

  // Macros: protein first, fat floor protected, carbs take the rest.
  const proteinG = Math.round(s.proteinGPerKg * W);
  const remaining = Math.max(0, target - proteinG * 4);
  let fatG = Math.max(s.fatFloorGPerKg * W, (remaining * s.fatShareOfRemaining) / 9);
  fatG = Math.min(fatG, remaining / 9);
  const carbsG = Math.max(0, (remaining - fatG * 9) / 4);

  return {
    targetKcal: target,
    expenditureKcal: model.expenditureKcal,
    energyDeltaKcal: Math.round(energyDelta),
    ratePctPerWeek: rate,
    expectedWeeklyChangeKg: round((rate / 100) * W, 2),
    changeFromPreviousKcal: previousTargetKcal == null ? null : target - previousTargetKcal,
    macros: { proteinG, fatG: Math.round(fatG), carbsG: Math.round(carbsG) },
    notes,
  };
}

/**
 * Optional "activity-aware" daily target. Uses Cronometer's burned estimate only for the
 * day-to-day SHAPE, scaled by how wrong Cronometer has been for this user.
 * Off by default: it reintroduces some of the wearable/formula error MacroFactor deliberately avoids.
 */
function activityAwareDailyTarget({ weeklyTargetKcal, calibrationRatio, cronometerBurnedAvgKcal, cronometerBurnedTodayKcal }) {
  if (!calibrationRatio || !cronometerBurnedAvgKcal || cronometerBurnedTodayKcal == null) return weeklyTargetKcal;
  const extra = calibrationRatio * (cronometerBurnedTodayKcal - cronometerBurnedAvgKcal);
  return Math.round((weeklyTargetKcal + extra) / 10) * 10;
}

function round(v, dp) { const f = 10 ** dp; return Math.round(v * f) / f; }
function roundOrNull(v) { return v == null ? null : Math.round(v); }

// ---------------------------------------------------------------------------
// Cronometer CSV helpers (for the manual-import fallback and for tests).
// Column names follow Cronometer's web "Export Data" files; match headers
// case-insensitively and tolerate extra/missing columns — they change over time.
// ---------------------------------------------------------------------------
const LB_TO_KG = 0.45359237;
const KJ_TO_KCAL = 1 / 4.184;

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), (r[i] ?? '').trim()])));
}

/** dailysummary.csv ("Export Daily Nutrition") → [{date, intakeKcal, excluded?}] */
function parseDailyNutritionCsv(text) {
  return parseCsv(text).map((r) => {
    const date = r['date'] || r['day'];
    let kcal = r['energy (kcal)'] !== undefined ? parseFloat(r['energy (kcal)']) : NaN;
    if (Number.isNaN(kcal) && r['energy (kj)'] !== undefined) kcal = parseFloat(r['energy (kj)']) * KJ_TO_KCAL;
    const completed = r['completed'];
    return {
      date,
      intakeKcal: Number.isFinite(kcal) ? kcal : null,
      // If the export has a Completed column and the day is explicitly not complete, don't trust it.
      excluded: completed !== undefined && /^(false|no|0)$/i.test(completed),
    };
  }).filter((r) => r.date);
}

/** biometrics.csv ("Export Biometrics") → [{date, weightKg}] (first weigh-in of each day) */
function parseBiometricsCsv(text) {
  const out = [];
  for (const r of parseCsv(text)) {
    if ((r['metric'] || '').toLowerCase() !== 'weight') continue;
    const amount = parseFloat(r['amount']);
    if (!Number.isFinite(amount)) continue;
    const unit = (r['unit'] || '').toLowerCase();
    const kg = unit.startsWith('lb') ? amount * LB_TO_KG : amount;
    out.push({ date: r['day'] || r['date'], time: r['time'] || '', weightKg: round(kg, 2) });
  }
  out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return out.map(({ date, weightKg }) => ({ date, weightKg }));
}
/*</upstream>*/
window.CMA.tdee = Object.freeze({
  RESPONSIVENESS,
  DEFAULT_CONFIG,
  addDays,
  daysBetween,
  normaliseDays,
  runExpenditureModel,
  DEFAULT_CHECKIN,
  weeklyCheckIn,
  activityAwareDailyTarget,
  parseCsv,
  parseDailyNutritionCsv,
  parseBiometricsCsv,
  UPSTREAM_SHA256: '62928423307b610ce012da7b397b570e0b51f8e8521cc1d88ef70d2b9ad67e21',
});
})();
