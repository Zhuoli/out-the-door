# 🌿 Out the Door

**Find the hour to go outside, then close the tab.** Say what you want to do in plain words ("45 min walk with the dog before dark, I hate wind"). **Gemma, running on your own device**, turns that into a plan; code scores the free [Open-Meteo](https://open-meteo.com/) forecast and picks the best window; you get a calendar reminder and a pocket card that still opens with no signal.

**Live:** https://out-the-door-jade.vercel.app · Built for the DEV Hacktoberfest 2026 Open-Source AI Challenge, Week 1: *Touch Grass*. Repo started Oct 5, 2026.

## Why

The screen should be the shortest part of going outside. Weather apps make you read 72 hourly rows and do the math yourself ("is 40% at 3 PM worse than 15 km/h wind at 5?"), and by then you've spent ten minutes on your phone and it's dark. Out the Door asks one question, gives one answer, puts it on your calendar, and tells you to close the tab.

## What does what

| Part | Done by | Notes |
|---|---|---|
| Read "after I log off at 5:30, take the pup around the lake" into `{activity, durationMin, earliest, latest, days, avoid}` | **Gemma** | JSON only; few-shot prompt in `src/plan.js` |
| Check and repair Gemma's JSON | code | unknown activity → walk, bad times dropped, durations clamped, "stargazing but avoid dark" fixed; every repair is shown to you |
| Score every hour for the activity (rain chance and mm, wind and gusts, feels-like temperature, UV, cloud for stars, daylight from sunrise/sunset) | code | activity profiles in `ACTIVITIES` |
| Pick the best non-overlapping windows | code | window score = 0.6 × mean + 0.4 × worst hour, so one soggy hour sinks it; birding gets a dawn bonus, foliage a golden-hour bonus, sooner beats later |
| If nothing good fits your limits, suggest the best time outside them | code | e.g. a Phoenix "run after work" moves to 6 AM |
| What to bring | code | from the numbers only |
| A 3-sentence "door note" (when, what to bring, one thing to notice) | **Gemma** | gets only the window's facts |
| Check the note | code | every clock time must be the window's start/end/sunset, every number must be in the forecast, no "rain" in a dry window. If it fails you see a plain note and Gemma's version underneath with the reason |
| `.ics` reminder (15 min before), pocket card, "Did you go?" log | code | all in `localStorage`, nothing sent anywhere |

### Two ways to run Gemma, both on your hardware
1. **Ollama on your computer (recommended):** Gemma 4 E2B reads your request *and* writes the note. Setup is below.
2. **In the browser (experimental):** `onnx-community/gemma-3-1b-it-ONNX` via [Transformers.js](https://github.com/huggingface/transformers.js) in a Web Worker (WebGPU if available, otherwise WebAssembly). One-time download of about 1 GB, then cached by the browser. In my tests the 1B model couldn't read requests reliably (see below), so in this mode it only writes the door note and the keyword rules do the reading.

Ollama setup:
   ```bash
   ollama pull gemma4:e2b
   OLLAMA_ORIGINS="https://out-the-door-jade.vercel.app" ollama serve
   ```
   Then pick "Gemma via Ollama" in the app.

There's also a "No model" option that uses simple keyword rules, which is how I measured what Gemma adds (below).

The site is static (HTML + ES modules + a service worker). No backend, no analytics, no API keys.

## How well does it work? (measured)

`npm run gemma:check` runs the real prompts. Two hand-labeled request sets in `samples/`:
- `requests.json` (20): the set I wrote while building, alongside the keyword rules.
- `requests-heldout.json` (12): written after the rules and prompt were frozen, phrased the way people actually talk ("stretch my legs", "I burn easily", "I melt above 20 degrees").

**Reading the request** (a request counts as "exact" only if all six fields are right; a missing duration must become the activity's default):

| Reader | Dev set (20), exact | Held-out set (12), exact | Held-out: activity / duration / time limits / day / avoid | Avg time per request (CPU) |
|---|---|---|---|---|
| Keyword rules (no model) | 15/20 | **0/12** | 7 / 9 / 11+11 / 12 / 6 of 12 | <1 ms |
| **Gemma 4 E2B** (`gemma4:e2b`, Ollama, Q4_K_M) | 13/20 | **7/12** | 12 / 12 / 12+12 / 10 / 9 of 12 | 5–6.5 s |
| Gemma 3 1B (ONNX q4, Transformers.js) | 0/20 | 0/12 | 5 / 6 / 6+6 / 9 / 1 of 12 | 3.8–4.5 s |

What this says:
- The keyword rules look fine on the set I wrote them against (15/20) and fall apart on new phrasing (0/12). "Stretch my legs for twenty minutes" has no digit; "I burn easily" means avoid sun; "tramp through the woods" is a hike. Gemma 4 E2B got the activity, the duration and the time limits right on all 12 held-out requests.
- Gemma 4's remaining misses are mostly judgment calls: it reads "once I log off at 5:30" as *today*, and it missed "avoid wind" in "I don't want to get blown around on the bike" and "avoid rain" in "needs to be dry".
- First version of the prompt: 12/20 on the dev set. It invented time limits ("leaf peeping before dark" became 17:00–21:00). Telling it "use null unless they named a time of day" and that "before dark" is an *avoid*, plus mapping "00:00–23:59" to "no limit" in code: 13/20, and the invented limits went away.
- Gemma 3 1B copied the few-shot example's `avoid` list into almost every answer and made up time windows. Three prompt variants (one example, no example, everything in one user turn) all scored 0/20 and 0/12. That's why the browser mode doesn't use it for reading.

Door notes are checked by `verifyNote()` against six real forecasts saved on Oct 5, 2026 (Seattle, Bergen in steady rain, Phoenix in a heat spell).

| Note writer | Passed the code check | By hand |
|---|---|---|
| Gemma 4 E2B | 6/6 | All accurate, but plain ("Look for the low golden light before sunset.") |
| Gemma 3 1B | 4/6 | The check caught "rain-soaked streets" in a dry window and a note that never said when to leave. It can't catch nature facts: 1B called a Pacific Wren "iridescent blue" and put a Phoenix runner "through the redwoods". |

Raw outputs, including every miss, are in `results/`.

## Develop

```bash
npm install          # only for the Node Gemma check
npm test             # unit tests: parsing/repair, scoring, windows, daylight, verifier, .ics
npm run gemma:check  # real Gemma runs: --engine=keyword|ollama|tjs --set=dev|heldout
npm run serve        # http://localhost:8080
```

Code map: `src/plan.js` (all deterministic logic, shared by browser and tests) · `src/engines.js` + `src/gemma-worker.js` (Gemma runtimes) · `src/app.js` (UI) · `sw.js` (offline shell).

## Credits
- [Gemma](https://ai.google.dev/gemma) (Google, open weights) via [Transformers.js](https://github.com/huggingface/transformers.js) and [Ollama](https://ollama.com/).
- Forecast and town search: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).
- The two small Gemma runtime wrappers follow the same pattern as my Weekend Challenge project, [Lease Buddy](https://github.com/Zhuoli/lease-buddy); everything else here is new.

Not a safety tool: check local conditions and trail reports before you head out.

## License
Apache-2.0
