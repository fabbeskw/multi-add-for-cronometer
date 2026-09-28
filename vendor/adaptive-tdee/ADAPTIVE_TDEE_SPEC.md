# Adaptive TDEE for the Cronometer extension — build spec

**For:** Claude Code, working on the Cronometer Chrome extension
**Goal:** Add an "Adaptive TDEE" section that works like MacroFactor's expenditure + weekly check-in system: it learns the user's real daily energy expenditure from what they log in Cronometer and how their weight trends, and updates their calorie (and macro) targets once a week.

---

## 0. Instructions for Claude Code

1. Copy these files into the extension (e.g. `src/tdee/`). They are plain ES modules with no dependencies and no DOM or `chrome.*` calls:
   - `adaptive-tdee.js` — the engine (model, weekly check-in, Cronometer CSV parsers). **Use it as-is; don't rewrite the maths.**
   - `adaptive-tdee.test.mjs`, `simulate.mjs` — tests (`node --test`; 17 pass). Keep them in the repo and run them in CI if there is one.
   - `evaluate.mjs` — optional benchmark against a simpler method (§7).
2. Build the **data layer** (§2): produce one record per diary day `{ date, intakeKcal, weightKg, burnedKcal, excluded }` from whatever Cronometer access the extension already has.
3. Build **storage + recompute** (§5) and the **UI section** (§6).
4. Wire the **weekly check-in** flow (§4).
5. Check the **acceptance criteria** (§8).

If something in the existing extension conflicts with this spec (data access method, storage keys, UI framework), keep the existing approach and adapt the spec to it. Only the engine's maths is fixed.

---

## 1. What MacroFactor does (research summary)

These are the behaviours we copy. Sources are at the end.

| Principle | MacroFactor behaviour | What we do |
|---|---|---|
| Core equation | Expenditure = calories in − change in stored energy. Stored-energy change comes from the **trend** weight, not raw scale weight. | Same. |
| Energy per kg | V3 uses the same energy density for gain and loss (≈3500 kcal/lb). Earlier versions used a smaller figure for gain, which added a persistent upward bias of up to ~80 kcal/day. | 7700 kcal/kg for both directions. |
| Wearable/formula burn | Not used for the estimate, because its errors are large and not random. The estimate comes only from intake and weight. | Cronometer's "burned" is used for **three things only**: the starting estimate, a comparison ("Cronometer overestimates you by 8%"), and an optional activity-aware daily target (off by default). |
| Adherence-neutral | Uses what you **actually ate**, never the target. Going over target doesn't lead to a "make-up" cut the next week. Each week stands on its own. | Same. The engine never sees the target. |
| Start-up | The initial estimate holds for the first days. It starts moving after about a week and is dialled in after 2–3 weeks (14–30 days). Early on it allows bigger moves, which can overshoot by 50–150 kcal before settling. | Warm-up of 7 days with the estimate frozen. After that the filter's confidence controls the speed: big moves early, small moves later. |
| Missing data | V3 keeps updating with up to 3 of 7 days of food unlogged, estimating what was eaten on those days. More gaps than that pauses updates ("holding"). It needs at least 1 weigh-in per 7 days (3+ is ideal). After a break it carries forward the last high-confidence value. | Same thresholds. Missing food days are filled with the recent logged average and given a wider error. During holding the estimate is frozen and its uncertainty doesn't grow. |
| Partial logging | A day logged only up to breakfast is trusted as-is and corrupts the estimate. Users are told to delete such days. | Detect likely partial days and let the user exclude them (§2.3). |
| Water noise | A salty meal, the period, or a week-long stall followed by a "whoosh" should barely move the estimate. V3's day-to-day changes are about 35% smaller than V2's. | A mean-reverting water state absorbs short swings. The default tuning favours stability. |
| Diet-phase shifts | Starting a cut drops glycogen, water and gut content, so the naive maths wrongly reads it as a rise in expenditure. The reverse happens when starting a bulk. V3 specifically reduces this. | Glycogen/gut term tied to energy balance (§3.3). |
| Weekly check-in | Target = expenditure ± surplus/deficit for the goal rate. The rate is set in **% of body weight per week**. There's an extra smoothing layer: a 1-week stall gets a small adjustment, and 3–4 weeks of consistent signal gets the full one. The user can skip a check-in. | Same formula. The filter gives the "hedge first, commit later" behaviour, and there's a safety cap on weekly change (§4). |
| Macros | Protein comes first and scales with body weight or lean mass. Fat never drops below a minimum. Carbs fill the rest. | Same (§4.3). |
| Tone | No red numbers and no shaming when you go over. Numbers are information, not judgement. | Same in the UI. |
| Known weak spots | Persistent water changes (starting creatine, switching to low-carb) and week-long anomalies (a cycling trip) mislead it for 1–2 weeks. MacroFactor's advice is to skip check-ins until it settles. | Same. Offer "Skip this week". |

---

## 2. Data from Cronometer

### 2.1 Per-day record the engine needs

```js
{
  date: 'YYYY-MM-DD',        // Cronometer DIARY date (local), never derived from a UTC timestamp
  intakeKcal: 2143 | null,   // Energy consumed for the day; null if nothing logged
  weightKg: 81.4 | null,     // first weigh-in of that day (Cronometer biometric "Weight")
  burnedKcal: 2610 | null,   // Cronometer's Energy Burned for that day (BMR + baseline activity + exercise [+ TEF if enabled])
  excluded: false            // true = user says this day was only partly logged → treated as missing
}
```

Conversions: lb × 0.45359237 → kg; kJ ÷ 4.184 → kcal. Store everything in kg/kcal internally and convert only for display.

### 2.2 Where to get it (in order of preference)

1. **Whatever the extension already reads.** Keep that.
2. **Cronometer's own export endpoints, called through the user's logged-in session.** These are the same exports as Settings → Account → Export Data: *Daily Nutrition* (`dailysummary.csv`), *Biometrics*, *Exercises*. The web app uses GWT, so the request format is fiddly. The open-source `gocronometer` library documents it and notes that Cronometer allows **up to 10 exports per day** for personal use. So:
   - Cache everything in `chrome.storage.local`.
   - Fetch only the dates that are new or changed. Re-fetch the last ~3 days, because people edit recent days.
   - Stay well under 10 exports per day. Never pull the full history repeatedly.
3. **Manual CSV import (fallback, and always offered).** Parsers are included:
   - `parseDailyNutritionCsv(text)` accepts `Date`/`Day` plus `Energy (kcal)`/`Energy (kJ)`. It uses a `Completed` column if one is present.
   - `parseBiometricsCsv(text)` expects `Day, Time, Metric, Unit, Amount`, keeps `Metric = Weight`, converts lb to kg, and takes the first weigh-in of the day.

**Burned (verify on a real account).** Cronometer's burned figure is not a column in the daily nutrition export. Get it one of two ways:

- Read the Energy Summary "Burned" value in the diary for each day the user views, and cache it.
- Sum the Exercises export for the day. Cronometer says BMR and baseline activity are logged automatically each day, so check whether those rows appear in the export and whether the sum matches the diary's Burned circle.

Burned is only needed for the prior and the comparison, so sparse coverage is fine.

### 2.3 Data-quality rules

- **Today is incomplete.** Pass today's weigh-in but set today's `intakeKcal` to `null`. The engine already ignores today's food when deciding holding/updating.
- **Partial-day detection.** A logged day under 50% of the median of the previous 14 logged days gets a subtle "Fully logged?" prompt. Treat it as `excluded` until the user confirms. Offer "Yes, I fasted/ate little" to keep it as logged.
- **Excluded days** can be toggled per day from the section's history list.
- The engine already handles multiple weigh-ins per day (the first one wins), and typos like 8.1 instead of 81 (4-SD outlier rejection).
- Days before the first weigh-in are ignored.

---

## 3. The model (implemented in `runExpenditureModel`)

### 3.1 Plain-language version

Every morning the model predicts today's scale weight from yesterday's weight, yesterday's logged calories, and its current expenditure estimate. It compares that prediction with the actual weigh-in.

- A lower weight than predicted means you probably burn more than it thought, so E goes up a little.
- A higher weight than predicted means E goes down a little.

"A little" is set by two things: how confident the model already is, and how noisy weigh-ins normally are. That's why it moves quickly in week 2 and slowly in month 3, and why one salty dinner barely registers.

This is a 3-state Kalman filter. Why it was chosen over a moving average is in §7.

### 3.2 State and equations (per day)

State: `W` = tissue weight (kg), `E` = expenditure (kcal/day), `H` = transient water (kg).

```
Predict (overnight, using day t's intake I_t):
  W ← W + (I_t − E) / 7700
  E ← E                       (random walk, SD = expenditureDriftKcal per day; 0 while holding)
  H ← φ·H,  φ = exp(−1/waterTauDays)

Observe (morning weigh-in y):
  G  = γ · (EMA_4d(intake) − E), capped at ±1.5% body weight      (glycogen/gut term)
  y  = W + G + H + noise
  standard Kalman update; the gain on E is forced to 0 during warm-up/holding (Joseph-form covariance)

Displayed trend weight = W + G.  Displayed expenditure = E ± sqrt(Var E).
```

Missing weigh-in: skip the observe step. Missing food: use the mean of logged days in the last 14 and widen that day's process noise (35% intake error instead of 10%).

### 3.3 Parameters (`DEFAULT_CONFIG`)

| Key | Default | Meaning |
|---|---|---|
| `kcalPerKg` | 7700 | Energy per kg of tissue, same for gain and loss. |
| `priorSdKcal` | 400 | How wrong the starting estimate may be. MacroFactor cites 400–500 kcal individual errors for formula estimates. |
| `expenditureDriftKcal` | 15 | Main stability/responsiveness knob. Exposed to the user as **Stable 10 / Balanced 15 / Responsive 25** (`RESPONSIVENESS`). |
| `waterSdFrac`, `waterTauDays` | 0.6% of body weight, 3 days | Size and duration of water swings. |
| `scaleSdFrac` | 0.3% of body weight | Pure scale noise. |
| `glycogenKgPerKcal` | 0.0015 | About 0.8 kg lower on the scale at a 550 kcal/day deficit. Set 0 to disable. |
| `holdMinNutritionDays` / `holdMinWeighIns` | 4 / 1 per 7 days | Holding thresholds (MacroFactor V3). |
| `warmupDays` | 7 | Initial estimate "sticks around". |
| `calibratedSdKcal`, `calibrationMinDays` | 150, 14 | When to show "Calibrated". |

### 3.4 Starting estimate (prior)

In priority order:

1. The user's manual value (settings).
2. The mean Cronometer **burned** over the first 7 days with data.
3. The mean intake over the first 14 days.

`current.priorSource` reports which one was used.

### 3.5 Outputs

`runExpenditureModel(records, { initialExpenditureKcal?, config? })` returns:

- `days[]`, one per day: `trendWeightKg`, `expenditureKcal`, `expenditureSdKcal`, `status` (`warmup | updating | holding`), `calibrated`, `intakeUsedKcal`, `intakeImputed`, `weightOutlier`, `glycogenOffsetKg`, `waterOffsetKg`, `cronometerBurnedKcal`, and more.
- `current`: latest values plus:
  - `weeklyTrendChangeKg`
  - `avgIntake7Kcal`
  - `cronometerBurned14Kcal`
  - `cronometerCalibrationRatio` (= our E ÷ Cronometer's 14-day burned; below 1 means Cronometer overestimates)

The engine is deterministic and fast: a year of history is about 365 tiny steps. **Always recompute from the full history** when any day changes. There's no incremental state to keep in sync.

---

## 4. Weekly check-in (implemented in `weeklyCheckIn`)

### 4.1 Flow

- The user picks a check-in weekday (default Monday). The first check-in is offered after 7 days of data.
- On check-in day the section shows "Check in". The user reviews and **Accepts**, or **Skips this week** and keeps last week's target. Record both outcomes.
- **The target stays fixed between check-ins.** It changes only at an accepted check-in, never day to day (except with the optional activity-aware mode, §4.4).
- A goal change (e.g. cut → maintain) allows an immediate new check-in, with no weekly cap applied.

### 4.2 Calorie target

```
energyDelta = (ratePctPerWeek / 100) × trendWeightKg × 7700 / 7      (negative = deficit)
target      = expenditure + energyDelta
```

Guardrails, all configurable in `DEFAULT_CHECKIN`:

- Loss rate is capped at 1.0% of body weight per week, gain at 0.5%.
- Calorie floor: 1200 (female) / 1500 (male) / 1350 (other).
- Once calibrated and with the goal unchanged, the target moves by at most ±250 kcal per check-in. The rest follows next week if the trend holds.
- Targets are rounded to 10 kcal.
- If status isn't `updating`, add the note "based on last confident estimate".

Goal presets (percent of body weight per week; show the kg/lb-per-week equivalent next to each):

- **Lose:** 0.25 / 0.5 / 0.75 / 1.0
- **Maintain:** 0
- **Gain:** 0.1 / 0.25 / 0.5

### 4.3 Macros

1. **Protein:** `proteinGPerKg` × trend weight. Default 1.8 g/kg; settings offer 1.6 / 1.8 / 2.2.
2. **Fat:** the larger of 0.6 g/kg (floor) and 35% of the non-protein calories. Settings offer a split: carb-leaning 25%, balanced 35%, fat-leaning 50%.
3. **Carbs:** the remainder.

### 4.4 Optional: activity-aware daily target (off by default)

`activityAwareDailyTarget()` shifts each day's target by `calibrationRatio × (today's Cronometer burned − its 14-day average)`. This gives more food on big training days, scaled down by however much Cronometer usually overestimates you.

- Label it **"Experimental — follows Cronometer's activity estimate"**.
- MacroFactor deliberately avoids this, because it brings the wearable's errors back into the daily target.

### 4.5 Pushing the target into Cronometer

v1 is **display only**. Show "Your new target: 2,060 kcal" with a copy button and a note to set it in Cronometer → Targets.

Writing the target back automatically would need undocumented GWT calls. It's a possible v2, behind an explicit opt-in.

---

## 5. Storage and recompute

`chrome.storage.local` keys (rename to fit the extension's conventions):

```js
tdee.days      // { 'YYYY-MM-DD': { intakeKcal, weightKg, burnedKcal, excluded, source, fetchedAt } }
tdee.settings  // { goal: { ratePctPerWeek }, sex, checkInWeekday, responsiveness, manualInitialKcal,
               //   proteinGPerKg, fatShare, activityAware, units: { weight:'kg'|'lb', energy:'kcal'|'kJ' }, modelStartDate }
tdee.checkins  // [{ date, accepted|skipped, targetKcal, expenditureKcal, sdKcal, trendWeightKg, ratePctPerWeek, macros, notes }]
tdee.fetchLog  // export calls per day (stay under Cronometer's 10/day)
```

- `modelStartDate` lets the user **reset** after a big life change (illness, pregnancy, a new training block). Pass only records on or after it.
- Recompute on: new data fetched, a day excluded or included, settings changed, or the section opened.

---

## 6. UI section ("Adaptive TDEE")

Match the extension's existing look. Neutral colours only: never red or green for over/under target.

1. **Expenditure card.** Large number with a small ± (e.g. "2,480 kcal/day ± 90"), plus a status chip:

   | Chip text | When |
   |---|---|
   | "Getting to know you · day 3 of 7" | `warmup` |
   | "Calibrating" | `updating`, not calibrated |
   | "Up to date" | `updating`, calibrated |
   | "Paused — log food on 4+ of 7 days and weigh in at least weekly" | `holding` |

   Below it, a one-line comparison: "Cronometer estimates 2,650 — your data says you burn about 6% less."

2. **Charts** (use whatever chart library the extension already has, otherwise lightweight SVG):
   - **Expenditure over time:** a line with a ±1 SD band, and a faint line for Cronometer's 7-day average burned.
   - **Weight:** scale weigh-ins as dots and the trend weight as a line. Mark outliers and excluded days subtly.

3. **This week card.** Current target and macros, next check-in date, **Check in** / **Skip this week** buttons, and the expected weekly change ("≈ −0.4 kg/week if you hit it").

4. **Check-in dialog.** Old target → new target with the change, then a plain-English "why":
   - Expenditure moved from X to Y.
   - Your trend changed by Z kg over the week while averaging N kcal/day.
   - Include any guardrail notes returned by `weeklyCheckIn().notes`.

5. **Settings:**
   - Goal and rate
   - Check-in day
   - Responsiveness (Stable / Balanced / Responsive)
   - Manual starting estimate
   - Protein level and fat/carb split
   - Sex (for the calorie floor only)
   - Units
   - Activity-aware toggle (experimental)
   - Reset / model start date
   - CSV import

6. **Data-quality nudges** (gentle, dismissible): partial-day prompt; "You've weighed in once this week — 3+ weigh-ins make this more accurate."

7. **Disclaimer** in the settings footer: estimates only, not medical advice; not suitable during pregnancy or with medical conditions affecting weight or fluid.

---

## 7. Why a Kalman filter rather than a moving average (evidence)

`evaluate.mjs` simulates people whose true expenditure is known. Each has realistic scale noise: water swings, salty-meal spikes, yesterday's food in the gut, glycogen shifts when the diet phase changes, missing weigh-ins and food days, and Cronometer's burned biased by 250–500 kcal. The table compares the engine with the common "10% exponential moving average of weight + 14-day window" method. Figures are averaged over 10 simulated people each.

Mean absolute error vs true expenditure (kcal/day):

| Scenario | Engine (default) | Simple EMA method |
|---|---|---|
| Steady maintenance | **48** | 75 |
| Bulk (+300/day) | **59** | 86 |
| Cut → holiday → activity change → maintenance | 137 | **107** |
| Starting estimate 500 too high | 116 | 109 |
| Half of food days unlogged | 143 | **113** |
| Weighing only twice a week | 139 | **103** |
| **Average** | 107 | 99 |

Week-to-week stability (95th percentile change in the estimate, steady maintenance):

| Engine (default) | Simple EMA method |
|---|---|
| **93 kcal** | 164 kcal |

Calibration from a starting estimate 400–500 kcal off:

| Method | After 3 weeks | After 4 weeks |
|---|---|---|
| Engine | ~130–140 kcal off | ~85–90 kcal off |
| Simple EMA | ~160–270 kcal off | ~90–155 kcal off |

Summary:

- **The engine wins on:**
  - Calibration speed, matching MacroFactor's "2–3 weeks".
  - Stability, which was the main point of MacroFactor's V3.
  - Accuracy at steady state.
  - A confidence band.
  - Principled handling of gaps.
- **It gives up:** some accuracy in long, messy scenarios with half the food days missing. There, MacroFactor-style holding freezes it more often than the simple method does.
- **Glycogen term:** turning it off made the cut scenarios 50–80 kcal worse.

Don't re-tune the defaults without re-running `node evaluate.mjs`. The simulator is synthetic, so treat these numbers as relative, not as real-world accuracy claims.

---

## 8. Acceptance criteria

- [ ] `node --test` passes (17 tests) and is run on every change to `src/tdee/`.
- [ ] With real Cronometer data, the section renders expenditure, status, trend weight, and the Cronometer comparison. Recompute takes under 50 ms for 1 year of data (the engine alone takes about 5 ms).
- [ ] Today's intake is never counted. Excluded days are treated as missing. lb/kJ accounts convert correctly.
- [ ] Holding kicks in with fewer than 4 logged days in the previous 7, or 0 weigh-ins in 7. The estimate is frozen while holding and resumes afterwards.
- [ ] Check-in:
  - Target = E ± goal delta, with every guardrail applied.
  - Accept and skip are both recorded.
  - The target doesn't change between check-ins.
  - A goal change allows an immediate re-check-in.
- [ ] Cronometer export calls never exceed 10 per day, and repeated opens use the cache.
- [ ] No red/green judgement colours anywhere in the section.

---

## 9. Sources

- MacroFactor — [Algorithms and core philosophy](https://macrofactor.com/macrofactors-algorithms-and-core-philosophy/)
- MacroFactor — [In-depth look at the V3 expenditure algorithm](https://macrofactor.com/expenditure-v3/) (missing-data thresholds, symmetric energy density, stability)
- MacroFactor Help — [How to interpret changes to your expenditure](https://help.macrofactorapp.com/en/articles/26-how-should-i-interpret-changes-to-my-energy-expenditure) (holding/updating, calibration time, water weight, wearables)
- MacroFactor Help — [How adjustments work for gain/loss goals](https://help.macrofactorapp.com/en/articles/222-how-does-macrofactor-make-adjustments-for-a-weight-gain-or-weight-loss-goal) (weekly smoothing, % body weight goals, macros)
- MacroFactor Help — [Weight trend](https://help.macrofactorapp.com/en/articles/21-weight-trend)
- Cronometer Support — [Energy Expenditure](https://support.cronometer.com/hc/en-us/articles/31974307318420-Energy-Expenditure) and [Energy Summary](https://support.cronometer.com/hc/en-us/articles/360060616191-Energy-Summary) (what "burned" contains)
- [gocronometer](https://github.com/jrmycanady/gocronometer) — how the export endpoints work, the 10-exports/day limit, CSV columns
- John Walker, *The Hacker's Diet* — [exponentially smoothed trend weight](https://www.fourmilab.ch/hackdiet/e4/pencilpaper.html) (the baseline method in §7)
