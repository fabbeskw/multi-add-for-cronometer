// Compare the Kalman model against simpler window-based estimators on synthetic people.
// Usage: node evaluate.mjs
import { runExpenditureModel } from './adaptive-tdee.js';
import { makePerson } from './simulate.mjs';
import { pathToFileURL } from 'node:url';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const SCENARIOS = {
  A_fullStory: {},
  B_priorHigh: { cronoBias: 500, vacation: null },
  C_steady: { plan: () => 2700, activityStep: null, vacation: null, glycogenKg: 0 },
  D_halfFoodMissing: { missIntake: 0.5, vacation: null },
  E_weigh2xWeek: { missWeight: 5 / 7, vacation: null },
  F_bulk: { plan: (t) => (t < 28 ? 2700 : 3000), cronoBias: -300, activityStep: null, vacation: null, glycogenKg: -0.9 },
  S_step250: { plan: () => 2700, activityStep: { day: 60, kcal: 250 }, vacation: null, glycogenKg: 0, days: 140, cronoBias: 0 },
};

// ---- estimators: each returns an array of E aligned to recs (null before it starts) ----
export const methods = {
  kalman: (cfg = {}) => (recs, prior) => {
    const res = runExpenditureModel(recs, { initialExpenditureKcal: prior, config: cfg });
    const map = new Map(res.days.map((d) => [d.date, d.expenditureKcal]));
    return recs.map((r) => map.get(r.date) ?? null);
  },
  // 10% EMA trend weight, 14-day window, 10% smoothing of the raw estimate (Hacker's-Diet style)
  emaWindow: ({ win = 14, alpha = 0.1 } = {}) => (recs, prior) => {
    let trend = null, E = prior; const trends = [];
    return recs.map((d, i) => {
      if (d.weightKg != null) trend = trend == null ? d.weightKg : trend + 0.1 * (d.weightKg - trend);
      trends.push(trend);
      if (i >= win && trends[i - win] != null) {
        const intakes = recs.slice(i - win + 1, i + 1).map((x) => x.intakeKcal).filter((x) => x != null);
        if (intakes.length >= win * 4 / 7) {
          const raw = mean(intakes) - (trend - trends[i - win]) * 7700 / win;
          E += alpha * (raw - E);
        }
      }
      return E;
    });
  },
  // Least-squares slope of raw scale weights over a trailing window + mean logged intake, then EMA.
  regression: ({ win = 21, alpha = 0.15 } = {}) => (recs, prior) => {
    let E = prior;
    return recs.map((d, i) => {
      if (i >= win - 1) {
        const w = [], t = [], intakes = [];
        for (let j = i - win + 1; j <= i; j++) {
          if (recs[j].weightKg != null) { w.push(recs[j].weightKg); t.push(j); }
          if (recs[j].intakeKcal != null && j < i) intakes.push(recs[j].intakeKcal);
        }
        if (w.length >= 3 * win / 7 && intakes.length >= (win - 1) * 4 / 7) {
          const tb = mean(t), wb = mean(w);
          let num = 0, den = 0; t.forEach((tt, k) => { num += (tt - tb) * (w[k] - wb); den += (tt - tb) ** 2; });
          const raw = mean(intakes) - (num / den) * 7700;
          E += alpha * (raw - E);
        }
      }
      return E;
    });
  },
};

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; }

export function evaluate(method) {
  const out = {};
  for (const [name, params] of Object.entries(SCENARIOS)) {
    const maes = [], wk = [], dy = [], stepLate = [];
    for (const seed of SEEDS) {
      const { recs, truth } = makePerson({ seed, ...params });
      const prior = Math.round(mean(recs.slice(0, 7).map((r) => r.burnedKcal)));
      const E = method(recs, prior);
      const errs = [];
      E.forEach((e, i) => { if (i >= 28 && e != null) errs.push(Math.abs(e - truth[i].tdee)); });
      maes.push(mean(errs));
      for (let i = 35; i < E.length; i++) {
        if (E[i] != null && E[i - 7] != null) wk.push(Math.abs(E[i] - E[i - 7]));
        if (E[i] != null && E[i - 1] != null) dy.push(Math.abs(E[i] - E[i - 1]));
      }
      if (name === 'S_step250') {
        // mean error 2–4 weeks after the step (how much of the change is still missing)
        const e = []; for (let i = 74; i < 88; i++) e.push(truth[i].tdee - E[i]);
        stepLate.push(mean(e));
      }
    }
    out[name] = Math.round(mean(maes));
    if (name === 'C_steady') { out.C_p95wk = Math.round(pct(wk, 0.95)); out.C_p95day = Math.round(pct(dy, 0.95)); }
    if (name === 'S_step250') out.S_missing2to4wk = Math.round(mean(stepLate));
  }
  const keys = Object.keys(SCENARIOS).filter((k) => k !== 'C_steady' && k !== 'S_step250');
  out.avgMAE = Math.round(mean(keys.map((k) => out[k]).concat([out.C_steady])));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = {
    'kalman (default)': evaluate(methods.kalman()),
    'kalman, glycogen term off': evaluate(methods.kalman({ glycogenKgPerKcal: 0 })),
    'kalman, responsive (drift 25)': evaluate(methods.kalman({ expenditureDriftKcal: 25 })),
    'simple: 10% EMA + 14-day window': evaluate(methods.emaWindow()),
  };
  console.table(rows);
}
