---
title: "Out the Door: tell Gemma what you want to do outside, get one time, close the tab"
published: true
description: "Say what you want to do outside. Gemma, on your own computer, reads it, code picks the hour from an open forecast, and you get a reminder and a pocket card that works with no signal."
cover_image: https://raw.githubusercontent.com/Zhuoli/out-the-door/main/docs/hero.png
tags: devchallenge, hf26challenge, ai, opensource
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05)*

## What I Built

**Out the Door** answers one question: *when should I go outside today?*

I work for myself, at a desk, in Seattle. "I'll go for a walk later" is a very easy promise to break. And when I do mean it, I open a weather app and start reading 72 rows of hourly numbers. Is 40% rain at 3 PM worse than 15 km/h wind at 5? Does a 45-minute walk still fit before sunset? Ten minutes later I'm still on my phone, and it's getting dark.

So the app is built to be the shortest part of going outside:

1. Say what you want in your own words: *"take the pup around the lake once I log off at 5:30, I don't want to get rained on"*.
2. **Gemma, running on your own computer**, turns that into a plan: activity, duration, time limits, which day, what to avoid.
3. Plain code scores every hour of the free Open-Meteo forecast for that activity (rain chance and millimetres, wind and gusts, feels-like temperature, UV, daylight from sunrise and sunset) and picks the best window.
4. You get **one time**, what to bring, and a 3-sentence "door note" from Gemma. Then three buttons: **add the reminder** (an `.ics` event with a 15-minute alarm), **save a pocket card** (it opens with no signal), and **I'm going**, which turns the whole screen green and tells you to close the tab.

When you come back, it asks "Did you go?" and counts your minutes outside for the week, on your device only.

It's for anyone who means to go outside and then doesn't: people at desks, dog owners, the "I'll garden this weekend" crowd, and birders who want the morning when the wind is down.

## Demo

**Live app:** https://out-the-door-jade.vercel.app

Here's a real run from today in Seattle with Gemma 4 E2B. I typed *"take the pup around the lake once I log off at 5:30, I don't want to get rained on"*:

![Out the Door result: read as Walk, 45 min, today, after 5:30 PM, avoid rain. Best window Today 6 PM to 6:45 PM, great 100/100, with Gemma's note and the three buttons](https://raw.githubusercontent.com/Zhuoli/out-the-door/main/docs/result.png)

Gemma read it as a 45-minute walk, today, after 5:30 PM, avoiding rain. (45 minutes is the default walk length, since I didn't give one.) The forecast was dry and calm, so the best window was **6:00–6:45 PM**, and because that ends 5 minutes after the 6:40 PM sunset, the note says to bring a headlamp. Gemma wrote: *"Leave at 6 PM and be back by 6:45 PM. Bring a headlamp since you finish near sunset. Look for the light as you walk."* The code checked every time and number in it against the forecast.

The public demo works without installing anything in "No model" mode (simple keyword rules), and there's an experimental in-browser Gemma 3 1B. The full version is Gemma 4 E2B on your own laptop through Ollama:

```bash
ollama pull gemma4:e2b
OLLAMA_ORIGINS="https://out-the-door-jade.vercel.app" ollama serve
```

Then pick "Gemma 4 via Ollama" in the app and click **Load Gemma**.

## Code

{% github Zhuoli/out-the-door %}

## How I Built It

It's a static site: HTML, ES modules, a service worker, and no backend. One rule shaped the code: **Gemma does the language and code does the arithmetic, and code checks everything Gemma writes.**

| Job | Who does it |
|---|---|
| Read "after I log off at 5:30, take the pup around the lake" into JSON: `{activity, durationMin, earliest, latest, days, avoid}` | **Gemma** |
| Check and repair that JSON: unknown activity becomes walk, bad times are dropped, durations are clamped, "stargazing but avoid the dark" is fixed. Every repair is shown to you | code |
| Score every hour and pick non-overlapping windows. A window scores 0.6 × its average hour plus 0.4 × its worst hour, so one soggy hour sinks it. Birding gets a dawn bonus, foliage a golden-hour bonus, and sooner beats later | code |
| If nothing good fits your limits, offer the best time outside them (a Phoenix "run after work" in a 36 °C afternoon moves to 6 AM) | code |
| What to bring | code, from the numbers |
| The door note: when to leave, what to bring, one thing to notice | **Gemma**, given only that window's facts |
| Check the note: every clock time must be the window's start, end or sunset, every number must be in the forecast, and no "rain" in a dry window. If it fails, you see a plain note first, with Gemma's version and the reason underneath | code |

The open pieces:
- **Gemma 4 E2B** (`gemma4:e2b`, Q4_K_M) through **Ollama**, on your own machine. It reads your request and writes the note.
- **Gemma 3 1B** (`onnx-community/gemma-3-1b-it-ONNX`) through **Transformers.js** in a Web Worker (WebGPU, or WebAssembly on CPU). It's a one-time 1 GB download, then cached.
- **Open-Meteo** for the forecast and town search: open data, free, no API key.

### I measured it, and the numbers changed the design

I wrote two hand-labeled sets of requests. The first 20 I wrote while building, alongside a keyword-rules baseline. The other 12 I wrote *after* freezing the rules and the prompt, phrased the way people actually talk: "stretch my legs for twenty minutes", "I burn easily", "I melt above 20 degrees". A request only counts if all six fields are right.

| Reader | Dev set (20) | Held-out set (12) | Avg per request (CPU) |
|---|---|---|---|
| Keyword rules, no model | 15/20 | **0/12** | <1 ms |
| **Gemma 4 E2B** via Ollama | 13/20 | **7/12** | 5–6.5 s |
| Gemma 3 1B in Transformers.js | 0/20 | 0/12 | 3.8–4.5 s |

Three things I learned:

1. **My keyword rules were overfit to my own examples.** 15/20 on the set I wrote them against and 0/12 on new phrasing. "Twenty minutes" has no digit, "I burn easily" means avoid sun, and "tramp through the woods" is a hike. On the held-out set, Gemma 4 E2B got the activity, the duration and both time limits right on **12 of 12**. Its misses were judgment calls: it read "once I log off at 5:30" as *today*, and it missed "avoid wind" in "I don't want to get blown around on the bike".
2. **The first prompt let Gemma invent limits.** On version 1 it scored 12/20 on the dev set and turned "leaf peeping, back before dark" into 17:00–21:00. Telling it "use null unless they named a time of day", and that "before dark" is something to *avoid* rather than a time limit, plus mapping 00:00–23:59 to "no limit" in code, got it to 13/20, and the invented limits went away.
3. **1B was too small for this job.** Gemma 3 1B copied the example's `avoid` list into almost every answer. I tried three prompt variants (one example, no example, everything in a single user turn) and all scored 0/20 and 0/12. So in the browser it only writes the note, and the keyword rules do the reading. I'd rather ship that honestly than pretend.

The notes, against six real forecasts I saved on October 5 (sunny Seattle, Bergen in steady rain, Phoenix in a heat spell):
- **Gemma 4 E2B:** 6/6 passed the code check, and when I read them by hand they were all accurate but plain ("Look for the low golden light before sunset.").
- **Gemma 3 1B:** 4/6 passed. The check caught "rain-soaked streets" in a dry window and a note that never said when to leave. It *can't* catch nature facts: 1B called a Pacific Wren "iridescent blue" and sent a Phoenix runner "through the redwoods". That's why code chooses the window and only Gemma's wording is ever at risk.

All raw outputs, misses included, are in [`results/`](https://github.com/Zhuoli/out-the-door/tree/main/results). There are also 12 unit tests covering parsing and repair, scoring, daylight, overlap, the note checker and the `.ics` time-zone math.

I built this with an AI coding agent pairing with me. The design calls, the labeled test sets and the decision to demote the 1B model came from the measurements above.

## Why Does Open Innovation Matter?

- **Where I'm going stays on my computer.** "Take the pup around the lake once I log off at 5:30" is a routine, a schedule and a place someone lives near. With an open-weight model on my own laptop, the only thing that leaves my device is a coordinate sent to a free forecast API. There's no account, no analytics and no server of mine.
- **It costs nothing to run, so it can stay simple.** There's no per-token bill and no key to hide, so it's a static page anyone can fork and host.
- **I could swap models and measure them.** The most useful thing I did was run the same prompts through Gemma 4 E2B and Gemma 3 1B and compare them against a no-model baseline on requests I hadn't tuned for. That's how I found out my rules were overfit and the 1B model wasn't ready for this job. With a closed API I'd have one model, a version that can change under me, and no way to run it offline.
- **The pocket card works with no signal.** The plan, the forecast it came from and the app itself are cached on the device, so the screen part ends before the trailhead.

I haven't taken it on a real trail yet. When I do, I'll add what I learn to the README.

## Prize Categories

- **Best Use of Gemma**: Gemma 4 E2B via Ollama reads the request and writes the door note, with Gemma 3 1B in the browser via Transformers.js as an experimental mode. Measured against a no-model baseline on held-out requests.
