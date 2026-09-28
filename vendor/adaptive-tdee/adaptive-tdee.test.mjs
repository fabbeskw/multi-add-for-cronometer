// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runExpenditureModel, weeklyCheckIn, normaliseDays, addDays,
  parseDailyNutritionCsv, parseBiometricsCsv, activityAwareDailyTarget,
} from './adaptive-tdee.js';
import { makePerson } from './simulate.mjs';

const START = '2026-01-01';
// Noise-free person: eats `intake(t)`, burns `tdee(t)`, weighs exactly their tissue weight.
function clean({ days = 60, startKg = 80, tdee = () => 2500, intake = () => 2500, weigh = () => true, logFood = () => true, burned = 2500 }) {
  const recs = []; let W = startKg;
  for (let t = 0; t < days; t++) {
    recs.push({ date: addDays(START, t), intakeKcal: logFood(t) ? intake(t) : null, weightKg: weigh(t) ? Math.round(W * 100) / 100 : null, burnedKcal: burned });
    W += (intake(t) - tdee(t)) / 7700;
  }
  return recs;
}

test('normaliseDays fills gaps, keeps first weigh-in, and treats excluded days as unlogged', () => {
  const d = normaliseDays([
    { date: '2026-01-01', intakeKcal: 2000, weightKg: 80 },
    { date: '2026-01-01', weightKg: 81 },
    { date: '2026-01-03', intakeKcal: 500, excluded: true },
  ]);
  assert.equal(d.length, 3);
  assert.equal(d[0].weightKg, 80);
  assert.equal(d[1].intakeKcal, null);
  assert.equal(d[2].intakeKcal, null);
});

test('prior comes from Cronometer burned when no manual value is given', () => {
  const r = runExpenditureModel(clean({ days: 10, burned: 2300 }));
  assert.equal(r.current.priorKcal, 2300);
  assert.equal(r.current.priorSource, 'cronometer');
  assert.equal(r.days[0].status, 'warmup');
  assert.equal(r.days[0].expenditureKcal, 2300);
});

test('manual initial estimate overrides Cronometer', () => {
  const r = runExpenditureModel(clean({ days: 10 }), { initialExpenditureKcal: 2800 });
  assert.equal(r.current.priorKcal, 2800);
  assert.equal(r.current.priorSource, 'manual');
});

test('expenditure is frozen during warm-up', () => {
  const r = runExpenditureModel(clean({ days: 7, tdee: () => 2900, intake: () => 2200, burned: 2400 }));
  for (const d of r.days) assert.equal(d.expenditureKcal, 2400);
});

test('recovers true expenditure from a wrong prior on clean data (maintenance)', () => {
  const r = runExpenditureModel(clean({ days: 56, tdee: () => 2500, intake: () => 2500, burned: 2100 }));
  assert.ok(Math.abs(r.current.expenditureKcal - 2500) < 60, `got ${r.current.expenditureKcal}`);
});

test('recovers true expenditure during a steady deficit', () => {
  const r = runExpenditureModel(clean({ days: 70, tdee: () => 2600, intake: () => 2100, burned: 2600 }), { config: { glycogenKgPerKcal: 0 } });
  assert.ok(Math.abs(r.current.expenditureKcal - 2600) < 60, `got ${r.current.expenditureKcal}`);
  assert.ok(r.current.weeklyTrendChangeKg < -0.3);
});

test('holds (freezes expenditure) when fewer than 4 of the previous 7 days are logged', () => {
  const recs = clean({ days: 40, burned: 2500, logFood: (t) => t < 21 || t % 3 === 0 });
  const r = runExpenditureModel(recs);
  const late = r.days.filter((d) => d.date >= addDays(START, 30));
  assert.ok(late.every((d) => d.status === 'holding'));
  const first = late[0].expenditureKcal;
  assert.ok(late.every((d) => d.expenditureKcal === first));
});

test('holds when there is no weigh-in in the last 7 days, and resumes afterwards', () => {
  const recs = clean({ days: 50, weigh: (t) => t < 20 || t >= 35 });
  const r = runExpenditureModel(recs);
  const at = (t) => r.days.find((d) => d.date === addDays(START, t));
  assert.equal(at(30).status, 'holding');
  assert.equal(at(40).status, 'updating');
});

test('ignores an obvious mistyped weigh-in', () => {
  const recs = clean({ days: 30 });
  recs[25].weightKg = 8.0; // meant 80.0
  const r = runExpenditureModel(recs);
  const day = r.days.find((d) => d.date === recs[25].date);
  assert.equal(day.weightOutlier, true);
  assert.ok(Math.abs(r.current.trendWeightKg - 80) < 0.3);
});

test('is deterministic', () => {
  const { recs } = makePerson({ seed: 42, days: 90 });
  assert.deepEqual(runExpenditureModel(recs), runExpenditureModel(recs));
});

test('no systematic upward bias from symmetric weight noise (V3 bias fix)', () => {
  let bias = 0;
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const { recs, truth } = makePerson({ seed, days: 120, plan: () => 2700, activityStep: null, vacation: null, glycogenKg: 0, cronoBias: 0 });
    const r = runExpenditureModel(recs);
    const tail = r.days.slice(-60);
    bias += tail.reduce((a, d, i) => a + d.expenditureKcal - truth[truth.length - 60 + i].tdee, 0) / tail.length;
  }
  bias /= 6;
  assert.ok(Math.abs(bias) < 60, `bias ${bias.toFixed(0)}`);
});

test('noisy synthetic user: within ~150 kcal after 4 weeks of steady maintenance', () => {
  const errs = [21, 22, 23, 24, 25, 26].map((seed) => {
    const { recs, truth } = makePerson({ seed, days: 60, plan: () => 2700, activityStep: null, vacation: null, glycogenKg: 0, cronoBias: -400 });
    const r = runExpenditureModel(recs);
    return Math.abs(r.current.expenditureKcal - truth[truth.length - 1].tdee);
  });
  const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mae < 150, `mae ${mae.toFixed(0)}`);
});

test('check-in: −0.5%/week at 80 kg is a ~440 kcal/day deficit', () => {
  const c = weeklyCheckIn({ model: { expenditureKcal: 2500, trendWeightKg: 80, calibrated: true, status: 'updating' }, goal: { ratePctPerWeek: -0.5 } });
  assert.equal(c.energyDeltaKcal, -440);
  assert.equal(c.targetKcal, 2060);
  assert.equal(c.expectedWeeklyChangeKg, -0.4);
});

test('check-in: caps aggressive rates, respects calorie floor, limits weekly swings once calibrated', () => {
  const m = { expenditureKcal: 1700, trendWeightKg: 60, calibrated: true, status: 'updating' };
  const a = weeklyCheckIn({ model: m, goal: { ratePctPerWeek: -2 }, sex: 'female' });
  assert.equal(a.ratePctPerWeek, -1);
  assert.equal(a.targetKcal, 1200);
  const b = weeklyCheckIn({ model: { ...m, expenditureKcal: 2600 }, goal: { ratePctPerWeek: 0 }, previousTargetKcal: 2000 });
  assert.equal(b.targetKcal, 2250);
  const c = weeklyCheckIn({ model: { ...m, expenditureKcal: 2600 }, goal: { ratePctPerWeek: 0 }, previousTargetKcal: 2000, goalChanged: true });
  assert.equal(c.targetKcal, 2600);
});

test('check-in: macros add back up to the target', () => {
  const c = weeklyCheckIn({ model: { expenditureKcal: 2600, trendWeightKg: 85, calibrated: true, status: 'updating' }, goal: { ratePctPerWeek: -0.5 } });
  const { proteinG, fatG, carbsG } = c.macros;
  assert.ok(Math.abs(proteinG * 4 + fatG * 9 + carbsG * 4 - c.targetKcal) <= 15);
  assert.ok(fatG >= 0.6 * 85 - 1);
});

test('activity-aware target scales Cronometer burn by the learned ratio', () => {
  assert.equal(activityAwareDailyTarget({ weeklyTargetKcal: 2000, calibrationRatio: 0.9, cronometerBurnedAvgKcal: 2500, cronometerBurnedTodayKcal: 2900 }), 2360);
  assert.equal(activityAwareDailyTarget({ weeklyTargetKcal: 2000, calibrationRatio: null, cronometerBurnedAvgKcal: 2500, cronometerBurnedTodayKcal: 2900 }), 2000);
});

test('CSV parsers: kcal/kJ, Completed flag, lbs→kg, first weigh-in first', () => {
  const nut = parseDailyNutritionCsv('Date,Energy (kcal),Protein (g),Completed\n2026-01-01,2100.5,150,true\n2026-01-02,640,40,false\n');
  assert.deepEqual(nut, [
    { date: '2026-01-01', intakeKcal: 2100.5, excluded: false },
    { date: '2026-01-02', intakeKcal: 640, excluded: true },
  ]);
  const kj = parseDailyNutritionCsv('Date,Energy (kJ)\n2026-01-01,8368\n');
  assert.equal(Math.round(kj[0].intakeKcal), 2000);
  const bio = parseBiometricsCsv('Day,Time,Group,Metric,Unit,Amount\n2026-01-01,08:00 AM,,Weight,lbs,176.4\n2026-01-01,07:00 AM,,Weight,lbs,176.0\n2026-01-01,,,Blood Pressure,mmHg,120/80\n');
  assert.equal(bio.length, 2);
  assert.equal(bio[0].weightKg, 79.83);
});
