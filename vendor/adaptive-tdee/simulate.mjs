// Synthetic people whose TRUE expenditure is known, for tests and evaluate.mjs.
// Default person (85 kg, true TDEE 2700): 4 weeks maintenance → cut at 2150 → 10-day
// untracked holiday eating +600 → activity +250 kcal/day from day 130 → maintenance at 2600.
// Scale weight = tissue + glycogen shift on diet-phase change + AR(1) water + salty-meal
// spikes + yesterday's food in the gut + scale noise. 15% of food days and 25% of
// weigh-ins missing at random. Cronometer's "burned" is biased 250 low with exercise-day swings.
import { addDays } from './adaptive-tdee.js';

function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export function makePerson({
  seed = 1, days = 200, startKg = 85, baseTdee = 2700, kcalPerKgTruth = 7700,
  plan = (t) => (t < 28 ? 2700 : t < 160 ? 2150 : 2600),
  intakeNoise = 350, missIntake = 0.15, missWeight = 0.25, vacation = [95, 105], vacationExtra = 600,
  cronoBias = -250, glycogenKg = 0.9, activityStep = { day: 130, kcal: 250 }, waterSdFrac = 0.006, scaleSdFrac = 0.003,
  gutKgPerKcal = 0.0005, spikes = true,
} = {}) {
  const r = rng(seed);
  let W = startKg, water = 0, spike = 0, gly = 0, adapt = 0, gut = 0, prevIntake = null;
  const phi = Math.exp(-1 / 3);
  const recs = [], truth = [];
  const start = '2026-01-01';
  for (let t = 0; t < days; t++) {
    const date = addDays(start, t);
    const planned = plan(t);
    const deficitNow = planned < baseTdee - 200;
    adapt += ((deficitNow ? -120 : 0) - adapt) / 28;            // slow metabolic adaptation
    const act = activityStep && t >= activityStep.day ? activityStep.kcal : 0;
    const tdee = baseTdee + 22 * (W - startKg) + adapt + act;    // TRUE average expenditure
    // glycogen/gut content shifts when diet phase changes
    const glyTarget = deficitNow ? -glycogenKg : 0; gly += (glyTarget - gly) / 2.5;
    water = phi * water + waterSdFrac * W * Math.sqrt(1 - phi * phi) * gauss(r);
    if (spikes && r() < 0.05) spike += 0.8 + 0.6 * r();           // salty/carb-heavy meal
    spike *= 0.55;
    // yesterday's food still in the gut / extra glycogen after a big day
    if (prevIntake != null) gut = 0.5 * gut + gutKgPerKcal * (prevIntake - planned);
    const scale = W + gly + water + spike + gut + scaleSdFrac * W * gauss(r);
    const onVacation = vacation && t >= vacation[0] && t < vacation[1];
    let intake = planned + intakeNoise * gauss(r) + (onVacation ? vacationExtra : 0);
    const exerciseDay = r() < 3 / 7;
    const cronoBurned = baseTdee + cronoBias + (exerciseDay ? 350 : -150) + 22 * (W - startKg);
    recs.push({
      date,
      intakeKcal: onVacation || r() < missIntake ? null : Math.round(intake),
      weightKg: onVacation || r() < missWeight ? null : Math.round(scale * 10) / 10,
      burnedKcal: Math.round(cronoBurned),
    });
    truth.push({ date, tdee, tissueKg: W });
    W += (intake - tdee) / kcalPerKgTruth;
    prevIntake = intake;
  }
  return { recs, truth };
}
