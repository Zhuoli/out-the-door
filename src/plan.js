// Out the Door: all the deterministic logic (shared by the browser and the tests).
// Gemma turns a plain-words request into constraints and writes the door note.
// This file checks Gemma's work, scores the forecast, and picks the window.

export const ACTIVITIES = {
  walk:    { label: 'Walk',            emoji: '🚶', comfort: [6, 24],  maxWind: 30, rainTol: 0.5, daylight: true,  defaultMin: 45 },
  run:     { label: 'Run',             emoji: '🏃', comfort: [4, 18],  maxWind: 25, rainTol: 0.6, daylight: true,  defaultMin: 40 },
  hike:    { label: 'Hike',            emoji: '🥾', comfort: [5, 22],  maxWind: 30, rainTol: 0.3, daylight: true,  defaultMin: 180 },
  bike:    { label: 'Bike ride',       emoji: '🚲', comfort: [8, 26],  maxWind: 20, rainTol: 0.3, daylight: true,  defaultMin: 60 },
  garden:  { label: 'Garden',          emoji: '🌱', comfort: [6, 26],  maxWind: 30, rainTol: 0.2, daylight: true,  defaultMin: 60 },
  birding: { label: 'Birding',         emoji: '🐦', comfort: [2, 24],  maxWind: 18, rainTol: 0.3, daylight: true,  defaultMin: 90 },
  foliage: { label: 'Fall foliage',    emoji: '🍂', comfort: [4, 24],  maxWind: 30, rainTol: 0.3, daylight: true,  defaultMin: 90 },
  picnic:  { label: 'Picnic / sit outside', emoji: '🧺', comfort: [14, 28], maxWind: 18, rainTol: 0.1, daylight: true, defaultMin: 60 },
  stars:   { label: 'Stargazing',      emoji: '🌌', comfort: [0, 26],  maxWind: 25, rainTol: 0.1, daylight: false, defaultMin: 60 },
};
export const AVOIDS = ['rain', 'wind', 'heat', 'cold', 'sun', 'dark'];
export const DAYS = ['today', 'tomorrow', 'next3'];

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------- constraints ----------

/** Pull the first JSON object out of model text (models sometimes wrap it in ```json fences or prose). */
export function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Validate and repair constraints (from Gemma or the keyword baseline).
 * Never trusts the model: unknown activity -> walk, durations clamped, bad times dropped.
 * Returns { constraints, repairs[] } so the UI can show what was fixed.
 */
export function normalizeConstraints(raw) {
  const repairs = [];
  const r = raw && typeof raw === 'object' ? raw : (repairs.push('no JSON: used defaults'), {});
  let activity = String(r.activity || '').toLowerCase().trim();
  if (!ACTIVITIES[activity]) { if (r.activity) repairs.push(`unknown activity "${r.activity}" -> walk`); activity = 'walk'; }
  const prof = ACTIVITIES[activity];
  let durationMin = Number(r.durationMin);
  if (!Number.isFinite(durationMin) || durationMin <= 0) { durationMin = prof.defaultMin; if (r.durationMin != null) repairs.push('bad duration -> default'); }
  if (durationMin > 600) { repairs.push(`duration ${durationMin} min capped at 600`); }
  durationMin = clamp(Math.round(durationMin), 15, 600);
  const time = (v, name) => {
    if (v == null || v === '') return null;
    const m = String(v).trim().match(HHMM);
    if (!m) { repairs.push(`ignored ${name} "${v}"`); return null; }
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  };
  let earliest = time(r.earliest, 'earliest');
  let latest = time(r.latest, 'latest');
  if (earliest === '00:00') earliest = null; // "any time" written as a full day
  if (latest === '23:59' || latest === '24:00') latest = null;
  if (earliest && latest && earliest >= latest) { repairs.push(`earliest ${earliest} is not before latest ${latest}: dropped both`); earliest = latest = null; }
  let days = String(r.days || 'next3').toLowerCase();
  if (!DAYS.includes(days)) { repairs.push(`unknown days "${r.days}" -> next3`); days = 'next3'; }
  const avoid = [...new Set((Array.isArray(r.avoid) ? r.avoid : []).map((a) => String(a).toLowerCase().trim()))];
  const badAvoid = avoid.filter((a) => !AVOIDS.includes(a));
  if (badAvoid.length) repairs.push(`ignored avoid: ${badAvoid.join(', ')}`);
  let good = avoid.filter((a) => AVOIDS.includes(a));
  if (activity === 'stars' && good.includes('dark')) { good = good.filter((a) => a !== 'dark'); repairs.push('stargazing needs the dark: dropped "avoid dark"'); }
  return {
    constraints: { activity, durationMin, earliest, latest, days, avoid: good },
    repairs,
  };
}

/** Keyword baseline: what you get with no model at all. Also the fallback if Gemma isn't loaded. */
export function keywordConstraints(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const has = (...w) => w.some((x) => t.includes(x));
  let activity = 'walk';
  const order = [
    ['stars', ['stargaz', 'stars', 'milky way', 'meteor']],
    ['birding', ['bird']],
    ['foliage', ['foliage', 'leaves', 'leaf', 'fall color', 'autumn color']],
    ['garden', ['garden', 'plant ', 'planting', 'weed', 'yard', 'bulbs']],
    ['picnic', ['picnic', 'sit outside', 'read outside', 'coffee outside']],
    ['bike', ['bike', 'cycling', 'cycle ', 'ride']],
    ['hike', ['hike', 'hiking', 'trail']],
    ['run', [' run', 'running', 'jog', '5k', '10k']],
    ['walk', ['walk', 'dog', 'stroll']],
  ];
  for (const [a, words] of order) if (has(...words)) { activity = a; break; }
  let durationMin = null;
  const h = t.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr|hrs|hour)/);
  const m = t.match(/(\d+)\s*(?:m\b|min)/);
  if (h) durationMin = Math.round(Number(h[1]) * 60) + (m && t.indexOf(m[0]) > t.indexOf(h[0]) ? Number(m[1]) : 0);
  else if (m) durationMin = Number(m[1]);
  else if (has('half an hour')) durationMin = 30;
  else if (has('an hour')) durationMin = 60;
  const days = has('today', 'tonight', 'this afternoon', 'this evening', 'after work', 'lunch') ? 'today' : has('tomorrow') ? 'tomorrow' : 'next3';
  const avoid = [];
  if (has('rain', 'wet', 'dry', 'drizzle')) avoid.push('rain');
  if (has('wind')) avoid.push('wind');
  if (has('hot', 'heat')) avoid.push('heat');
  if (has('cold', 'chilly', 'freez')) avoid.push('cold');
  if (has('before dark', 'daylight', 'dark')) avoid.push('dark');
  let earliest = null, latest = null;
  if (has('after work')) earliest = '17:00';
  if (has('lunch')) { earliest = '11:30'; latest = '14:00'; }
  if (has('morning')) latest = '12:00';
  if (has('afternoon')) earliest = '12:00';
  if (has('evening', 'after dinner')) earliest = '17:00';
  return normalizeConstraints({ activity, durationMin, earliest, latest, days, avoid }).constraints;
}

export const PARSE_SYSTEM = `You turn a person's plain-words plan to go outside into JSON. Output ONLY one JSON object, no prose.
Keys:
- "activity": one of ${Object.keys(ACTIVITIES).join(', ')}. Dog walks are "walk". Leaf peeping is "foliage".
- "durationMin": integer minutes they want outside. If not said, null.
- "earliest" and "latest": 24-hour "HH:MM" local time limits. Use null unless they named a time of day (like "after work", "morning", "by 3pm"). Never guess limits from the activity. "after work" means earliest "17:00". "lunch" means "11:30" to "14:00". "morning" means latest "12:00". "afternoon" means earliest "12:00".
- "days": "today", "tomorrow", or "next3" (default when not said).
- "avoid": list using only: ${AVOIDS.join(', ')}. "before dark" or "while it's light" means "dark" (and is NOT a time limit). "soaked", "dry" or "wet" means "rain". Only include what they said.`;

export function buildParseMessages(text) {
  return [
    { role: 'system', content: PARSE_SYSTEM },
    { role: 'user', content: 'Example: "quick 20 min jog tomorrow morning, not if it\'s raining"' },
    { role: 'assistant', content: '{"activity":"run","durationMin":20,"earliest":null,"latest":"12:00","days":"tomorrow","avoid":["rain"]}' },
    { role: 'user', content: 'Example: "kayak or a long walk, back before dark, not too windy"' },
    { role: 'assistant', content: '{"activity":"walk","durationMin":null,"earliest":null,"latest":null,"days":"next3","avoid":["dark","wind"]}' },
    { role: 'user', content: String(text).slice(0, 500) },
  ];
}

// ---------- forecast ----------

/** Turn an Open-Meteo response into an array of hour objects (local wall-clock times). */
export function toHours(om) {
  const h = om.hourly;
  const sun = {};
  (om.daily?.time || []).forEach((d, i) => { sun[d] = { rise: om.daily.sunrise[i], set: om.daily.sunset[i] }; });
  return h.time.map((time, i) => {
    const day = time.slice(0, 10);
    const s = sun[day];
    // Daylight if the hour starts at/after sunrise-30min and ends before sunset+30min (civil-ish twilight).
    const startMin = toMin(time.slice(11, 16));
    const daylight = s ? startMin >= toMin(s.rise.slice(11, 16)) - 30 && startMin + 60 <= toMin(s.set.slice(11, 16)) + 30 : !!h.is_day?.[i];
    return {
      time, day,
      temp: h.temperature_2m[i],
      feels: h.apparent_temperature?.[i] ?? h.temperature_2m[i],
      pop: h.precipitation_probability?.[i] ?? 0,
      mm: h.precipitation?.[i] ?? 0,
      wind: h.wind_speed_10m?.[i] ?? 0,
      gust: h.wind_gusts_10m?.[i] ?? 0,
      uv: h.uv_index?.[i] ?? 0,
      cloud: h.cloud_cover?.[i] ?? 0,
      daylight,
      sunrise: s?.rise, sunset: s?.set,
    };
  });
}

export function toMin(hhmm) { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; }
export function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** Score one hour for an activity, 0..100, with human-readable reasons. */
export function scoreHour(hr, c) {
  const p = ACTIVITIES[c.activity];
  const reasons = [];
  let s = 100;
  const rainW = c.avoid.includes('rain') ? 1.6 : 1;
  const rainPen = (hr.pop * (1 - p.rainTol) * 0.9 + hr.mm * 25) * rainW;
  if (rainPen > 0.5) { s -= rainPen; reasons.push(`${hr.pop}% rain chance${hr.mm ? `, ${hr.mm} mm` : ''}`); }
  const maxWind = c.avoid.includes('wind') ? p.maxWind * 0.6 : p.maxWind;
  const windy = Math.max(hr.wind, hr.gust * 0.6);
  if (windy > maxWind) { s -= (windy - maxWind) * 2.5; reasons.push(`wind ${Math.round(hr.wind)} km/h, gusts ${Math.round(hr.gust)}`); }
  let [lo, hi] = p.comfort;
  if (c.avoid.includes('cold')) lo += 4;
  if (c.avoid.includes('heat')) hi -= 4;
  if (hr.feels < lo) { s -= (lo - hr.feels) * 4; reasons.push(`feels like ${Math.round(hr.feels)}°C`); }
  if (hr.feels > hi) { s -= (hr.feels - hi) * 5; reasons.push(`feels like ${Math.round(hr.feels)}°C`); }
  // Inside the comfort band, nudge toward its middle so a perfect day still has a best hour.
  s -= Math.abs(hr.feels - (lo + hi) / 2) * 0.4;
  if (hr.uv >= 6 && (c.avoid.includes('sun') || c.avoid.includes('heat'))) { s -= (hr.uv - 5) * 6; reasons.push(`UV ${hr.uv}`); }
  if (c.activity === 'stars') { s -= hr.cloud * 0.6; if (hr.cloud > 30) reasons.push(`${hr.cloud}% cloud`); }
  return { score: clamp(Math.round(s), 0, 100), reasons };
}

function allowedHour(hr, c, nowLocal, firstDay) {
  if (nowLocal && hr.time < nowLocal.slice(0, 16)) return false; // already started
  const p = ACTIVITIES[c.activity];
  const needDay = p.daylight || c.avoid.includes('dark');
  if (needDay && !hr.daylight) return false;
  if (c.activity === 'stars' && hr.daylight) return false;
  const day0 = firstDay;
  if (c.days === 'today' && hr.day !== day0) return false;
  if (c.days === 'tomorrow' && hr.day !== addDays(day0, 1)) return false;
  return true;
}

/**
 * Find the best windows of `durationMin` (rounded up to whole hours) inside the constraints.
 * Window score = 0.6*mean + 0.4*worst hour, so one soggy hour sinks a window.
 * Birding gets a bonus near sunrise, foliage near golden hour (the hour before sunset).
 */
export function findWindows(hours, c, { nowLocal = null, top = 3 } = {}) {
  const n = Math.max(1, Math.ceil(c.durationMin / 60));
  const firstDay = (nowLocal || hours[0].time).slice(0, 10);
  const cands = [];
  for (let i = 0; i + n <= hours.length; i++) {
    const span = hours.slice(i, i + n);
    if (span.some((h) => h.day !== span[0].day)) continue; // keep a window inside one day
    if (!span.every((h) => allowedHour(h, c, nowLocal, firstDay))) continue;
    const startHHMM = span[0].time.slice(11, 16);
    const endMin = toMin(startHHMM) + c.durationMin;
    if (c.earliest && toMin(startHHMM) < toMin(c.earliest)) continue;
    if (c.latest && endMin > toMin(c.latest)) continue;
    const scored = span.map((h) => scoreHour(h, c));
    const mean = scored.reduce((a, b) => a + b.score, 0) / n;
    const worst = Math.min(...scored.map((x) => x.score));
    let score = 0.6 * mean + 0.4 * worst;
    const bonus = [];
    const rise = span[0].sunrise && toMin(span[0].sunrise.slice(11, 16));
    const set = span[0].sunset && toMin(span[0].sunset.slice(11, 16));
    if (c.activity === 'birding' && rise != null && toMin(startHHMM) - rise <= 90 && toMin(startHHMM) >= rise - 30) { score += 8; bonus.push('early morning, when birds are most active'); }
    if (c.activity === 'foliage' && set != null && endMin >= set - 90 && endMin <= set + 15) { score += 6; bonus.push('low golden light before sunset'); }
    // Sooner is better: a window today beats an equal one in two days (about -1 point per 12 hours).
    if (nowLocal) score -= Math.max(0, (Date.parse(`${span[0].time}Z`) - Date.parse(`${nowLocal.slice(0, 16)}Z`)) / 3.6e6) / 12;
    const end = minToHHMM(endMin);
    cands.push({
      day: span[0].day, start: startHHMM, end, durationMin: c.durationMin,
      score: Math.round(clamp(score, 0, 100)),
      tempMin: Math.round(Math.min(...span.map((h) => h.temp))), tempMax: Math.round(Math.max(...span.map((h) => h.temp))),
      feelsMin: Math.round(Math.min(...span.map((h) => h.feels))), feelsMax: Math.round(Math.max(...span.map((h) => h.feels))),
      popMax: Math.max(...span.map((h) => h.pop)), mm: +span.reduce((a, h) => a + h.mm, 0).toFixed(1),
      windMax: Math.round(Math.max(...span.map((h) => h.wind))), gustMax: Math.round(Math.max(...span.map((h) => h.gust))),
      uvMax: Math.max(...span.map((h) => h.uv)),
      sunset: span[0].sunset?.slice(11, 16) || null, sunrise: span[0].sunrise?.slice(11, 16) || null,
      reasons: [...new Set(scored.flatMap((x) => x.reasons))], bonus,
    });
  }
  cands.sort((a, b) => b.score - a.score || (a.day + a.start).localeCompare(b.day + b.start));
  const picked = [];
  for (const w of cands) {
    const overl = picked.some((p) => p.day === w.day && toMin(w.start) < toMin(p.end) && toMin(p.start) < toMin(w.end));
    if (!overl) picked.push(w);
    if (picked.length >= top) break;
  }
  return picked;
}

export function minToHHMM(m) { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
export function fmt12(hhmm) { let [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return m ? `${h}:${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`; }
export function verdict(score) { return score >= 80 ? 'great' : score >= 60 ? 'good' : score >= 40 ? 'okay' : 'rough'; }

/** What to bring, from numbers only (no model). */
export function packList(w, c) {
  const out = [];
  if (w.popMax >= 40 || w.mm > 0.2) out.push('rain shell');
  else if (w.popMax >= 20) out.push('a light layer in case of a shower');
  if (w.feelsMin <= 8) out.push('warm layer and gloves');
  else if (w.feelsMin <= 13) out.push('a fleece');
  if (w.feelsMax >= 27) out.push('extra water');
  if (w.uvMax >= 5) out.push('sunscreen');
  if (w.gustMax >= 35) out.push('a hat that stays on');
  if (c.activity === 'birding') out.push('binoculars');
  if (c.activity === 'hike' || w.durationMin >= 150) out.push('a snack');
  if (c.activity === 'stars') out.push('a red flashlight');
  if (w.sunset && toMin(w.end) >= toMin(w.sunset) - 30 && c.activity !== 'stars') out.push('a headlamp (you finish near sunset)');
  return out;
}

// ---------- the door note ----------

export function season(lat, day) {
  const m = Number(day.slice(5, 7));
  const north = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][m - 1];
  const flip = { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' };
  const name = new Date(`${day}T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${lat < 0 ? flip[north] : north} (${name})`;
}

export function buildNoteMessages(w, c, placeName, lat = 45) {
  const facts = [
    `Place: ${placeName}`,
    `Season: ${season(lat, w.day)}`,
    `Activity: ${ACTIVITIES[c.activity].label}`,
    `Day: ${w.day}`,
    `Leave at: ${fmt12(w.start)}`,
    `Back by: ${fmt12(w.end)}`,
    `Temperature: ${w.tempMin} to ${w.tempMax} °C (feels like ${w.feelsMin} to ${w.feelsMax} °C)`,
    `Rain chance: up to ${w.popMax}%`,
    `Wind: up to ${w.windMax} km/h`,
    w.sunset ? `Sunset: ${fmt12(w.sunset)}` : null,
    `Bring: ${packList(w, c).join(', ') || 'nothing special'}`,
    w.bonus.length ? `Why this time: ${w.bonus.join('; ')}` : null,
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: 'You write a short, warm note that gets someone off their screen and out the door. Use ONLY the facts given. Exactly 3 sentences: 1) when to leave and when to be back, 2) what to bring, 3) one concrete thing to look, listen or smell for while doing this activity at this place in this season (a kind of bird, tree, plant, sky or light) with no numbers in it. Use the times exactly as written (like "4 PM"). Do not invent any other numbers. No greeting, no emoji, no lists.' },
    { role: 'user', content: facts },
  ];
}

const TIME_RE = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;

/** Check the note against the window: every time must be a time we gave it, every number must be one we gave it. */
export function verifyNote(note, w, c) {
  const issues = [];
  const allowedTimes = new Set([w.start, w.end, w.sunset, w.sunrise].filter(Boolean).map((t) => toMin(t)));
  const times = [];
  for (const m of note.matchAll(TIME_RE)) {
    let min;
    if (m[4] != null) min = Number(m[4]) * 60 + Number(m[5]);
    else { let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'p') h += 12; min = h * 60 + Number(m[2] || 0); }
    times.push(min);
    if (!allowedTimes.has(min)) issues.push(`time "${m[0].trim()}" is not the window (${fmt12(w.start)}–${fmt12(w.end)})`);
  }
  if (!times.includes(toMin(w.start))) issues.push(`doesn't say to leave at ${fmt12(w.start)}`);
  const stripped = note.replace(TIME_RE, ' ');
  const allowedNums = new Set([w.tempMin, w.tempMax, w.feelsMin, w.feelsMax, w.popMax, w.windMax, w.durationMin, w.gustMax, Math.round(w.uvMax), 3].map(Number));
  for (const m of stripped.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (!allowedNums.has(v) && !allowedNums.has(Math.abs(v))) issues.push(`number ${m[0]} isn't in the forecast`);
  }
  const low = note.toLowerCase();
  if (w.popMax < 20 && /\b(rain(?!bow)|showers?|drizzle|umbrella|wet)\b/.test(low) && !/\b(no|not|without|little|low|unlikely|dry)\b[^.]{0,30}\b(rain|showers?|drizzle|wet)/.test(low)) issues.push('mentions rain but the window is dry');
  if (w.popMax >= 50 && /\bno rain\b|\bdry\b/.test(low)) issues.push('calls it dry but rain is likely');
  return { ok: issues.length === 0, issues };
}

export function templateNote(w, c) {
  const bring = packList(w, c);
  const notice = {
    walk: 'Notice which trees on your street have turned first.',
    run: 'Notice how your breathing settles after the first ten minutes.',
    hike: 'Notice where the trail smells like wet leaves and cedar.',
    bike: 'Notice the leaves piling up in the bike lane and give them room.',
    garden: 'Notice which beds are still warm enough to plant garlic and bulbs.',
    birding: 'Notice the flocks moving through: fall migration is on.',
    foliage: 'Notice the maples first; they usually turn before everything else.',
    picnic: 'Notice how the light changes as the afternoon goes on.',
    stars: 'Give your eyes twenty minutes in the dark before you decide what you can see.',
  }[c.activity];
  return `Leave at ${fmt12(w.start)} and be back by ${fmt12(w.end)}. Bring ${bring.length ? bring.join(', ') : 'just yourself'}. ${notice}`;
}

// ---------- calendar ----------

/** One VEVENT with a 15-minute reminder. Times are converted to UTC with the forecast's offset. */
export function toIcs(w, c, placeName, utcOffsetSeconds, note = '') {
  const toUtc = (day, hhmm) => {
    const ms = Date.parse(`${day}T${hhmm}:00Z`) - utcOffsetSeconds * 1000;
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const endDay = toMin(w.start) + c.durationMin >= 1440 ? addDays(w.day, 1) : w.day;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Out the Door//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${w.day}-${w.start.replace(':', '')}-${c.activity}@out-the-door`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toUtc(w.day, w.start)}`,
    `DTEND:${toUtc(endDay, w.end)}`,
    `SUMMARY:${esc(`${ACTIVITIES[c.activity].emoji} ${ACTIVITIES[c.activity].label} (Out the Door)`)}`,
    `LOCATION:${esc(placeName)}`,
    `DESCRIPTION:${esc(note)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Time to go outside', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Best plan inside the limits, plus (if that's rough) the best one if we drop the time-of-day and day limits. */
export function plan(hours, c, opts = {}) {
  const windows = findWindows(hours, c, opts);
  let relaxed = null;
  if (!windows.length || windows[0].score < 50) {
    const loose = { ...c, earliest: null, latest: null, days: 'next3' };
    const alt = findWindows(hours, loose, { ...opts, top: 1 })[0];
    if (alt && (!windows.length || alt.score >= windows[0].score + 15)) relaxed = alt;
  }
  return { windows, relaxed };
}
