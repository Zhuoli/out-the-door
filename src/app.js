import * as P from './plan.js';
import { BrowserGemma, OllamaGemma, readRequest } from './engines.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set: (k, v) => localStorage.setItem(k, JSON.stringify(v)) };
const params = new URLSearchParams(location.search);

let engine = null;     // loaded Gemma engine, or null
let place = store.get('otd.place');     // { name, lat, lon }
let forecast = store.get('otd.forecast'); // { at, om }
let last = null;       // last plan shown

const EXAMPLES = [
  '45 min walk with the dog before dark, I hate wind',
  'birding tomorrow morning for two hours',
  'catch the fall colors this week, about 90 minutes',
  'get the garlic planted before it rains',
  "I've been at my desk all day. 15 minutes outside, today.",
  'look at the stars tonight for an hour',
];
$('examples').innerHTML = EXAMPLES.map((e) => `<span class="chip" role="button" tabindex="0">${esc(e)}</span>`).join('');
$('examples').onclick = (e) => { if (e.target.classList.contains('chip')) { $('ask').value = e.target.textContent; } };
if (params.get('q')) $('ask').value = params.get('q');

// ---------- place + forecast ----------
function showPlace(extra = '') {
  if (!place) return;
  const age = forecast ? Math.round((Date.now() - forecast.at) / 60000) : null;
  $('place-status').innerHTML = `📍 <strong>${esc(place.name)}</strong>${age != null ? ` · forecast saved ${age < 60 ? `${age} min` : `${Math.round(age / 60)} h`} ago` : ''} ${extra}`;
}
async function fetchForecast() {
  const q = 'hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,uv_index,cloud_cover,is_day&daily=sunrise,sunset&timezone=auto&forecast_days=3';
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&${q}`);
  if (!r.ok) throw new Error(`forecast ${r.status}`);
  forecast = { at: Date.now(), om: await r.json(), for: place.name };
  store.set('otd.forecast', forecast);
}
async function setPlace(p) {
  place = p; store.set('otd.place', p);
  showPlace('· loading forecast…');
  try { await fetchForecast(); showPlace(); } catch { showPlace('· <em>offline: using the saved forecast</em>'); }
}
$('geo').onclick = () => navigator.geolocation.getCurrentPosition(
  (pos) => setPlace({ name: `${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)}`, lat: pos.coords.latitude, lon: pos.coords.longitude }),
  (err) => { $('place-status').textContent = `Couldn't get your location (${err.message}). Type a town instead.`; },
  { maximumAge: 3600e3, timeout: 10e3 });
$('place-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('place').value.trim(); if (!name) return;
  try {
    const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`)).json();
    const g = r.results?.[0];
    if (!g) { $('place-status').textContent = `No town called "${name}" found.`; return; }
    setPlace({ name: [g.name, g.admin1, g.country_code].filter(Boolean).join(', '), lat: g.latitude, lon: g.longitude });
  } catch { $('place-status').textContent = 'Town search needs a connection. Your saved forecast still works.'; }
};
if (params.get('lat') && params.get('lon')) setPlace({ name: params.get('place') || `${params.get('lat')}, ${params.get('lon')}`, lat: +params.get('lat'), lon: +params.get('lon') });
else if (place) { showPlace(); if (navigator.onLine && (!forecast || Date.now() - forecast.at > 30 * 60e3)) setPlace(place); }
else $('place-status').insertAdjacentHTML('beforeend', ' No place yet: tap "Use my location" or type a town.');

// ---------- Gemma ----------
function engineChoice() { return $('engine').value; }
$('engine').onchange = () => { engine = null; $('engine-status').textContent = ''; $('load').hidden = engineChoice() === 'none'; };
if (params.get('engine')) { $('engine').value = params.get('engine'); $('engine').onchange(); }
$('load').onclick = async () => {
  $('load').disabled = true;
  const files = {};
  try {
    if (engineChoice() === 'browser') {
      const e = new BrowserGemma({ onProgress: (p) => {
        if (p.status === 'progress' && p.total) {
          files[p.file] = [p.loaded, p.total];
          const [a, b] = Object.values(files).reduce(([x, y], [l, t]) => [x + l, y + t], [0, 0]);
          $('load-progress').hidden = false; $('load-progress').value = Math.round((a / b) * 100);
          $('engine-status').textContent = `Downloading Gemma… ${(a / 1e6).toFixed(0)} / ${(b / 1e6).toFixed(0)} MB (one time)`;
        } else if (p.status === 'fallback') $('engine-status').textContent = 'GPU path failed, switching to CPU…';
      } });
      $('engine-status').textContent = 'Starting Gemma…';
      await e.load(params.get('device') || undefined);
      engine = e;
    } else {
      const e = new OllamaGemma({ model: params.get('model') || 'gemma4:e2b' });
      await e.load(); engine = e;
    }
    $('load-progress').hidden = true;
    $('engine-status').textContent = `✅ ${engine.label} is ready.`;
  } catch (err) {
    engine = null;
    $('engine-status').textContent = engineChoice() === 'ollama'
      ? `Couldn't reach Ollama: ${err.message}. Start it with OLLAMA_ORIGINS="${location.origin}" ollama serve`
      : `Couldn't start Gemma: ${err.message}`;
  } finally { $('load').disabled = false; }
};

// ---------- plan ----------
const dayName = (day, nowDay) => day === nowDay ? 'Today' : day === P.addDays(nowDay, 1) ? 'Tomorrow' : new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
const localNow = (om) => new Date(Date.now() + om.utc_offset_seconds * 1000).toISOString().slice(0, 16);

$('go').onclick = async () => {
  const text = $('ask').value.trim() || $('ask').placeholder;
  if (!forecast) { $('place-status').innerHTML = '<strong>Pick a place first.</strong>'; return; }
  $('go').disabled = true; $('go').textContent = engine ? 'Gemma is reading…' : 'Finding…';
  try {
    const read = await readRequest(engineChoice() === 'none' ? null : engine, text);
    const c = read.constraints;
    $('read').innerHTML = [
      `${P.ACTIVITIES[c.activity].emoji} ${P.ACTIVITIES[c.activity].label}`, `${c.durationMin} min`,
      { today: 'today', tomorrow: 'tomorrow', next3: 'next 3 days' }[c.days],
      c.earliest && `after ${P.fmt12(c.earliest)}`, c.latest && `back by ${P.fmt12(c.latest)}`,
      ...c.avoid.map((a) => `avoid ${a}`),
    ].filter(Boolean).map((x) => `<span class="chip static">${esc(x)}</span>`).join('');
    $('repairs').textContent = `Read by ${read.source}.${read.repairs.length ? ` Fixed: ${read.repairs.join('; ')}.` : ''}${engine || engineChoice() === 'none' ? '' : ' Load Gemma above for requests the keyword rules miss.'}`;
    const om = forecast.om, hours = P.toHours(om), nowLocal = localNow(om);
    const { windows, relaxed } = P.plan(hours, c, { nowLocal });
    $('out').hidden = false;
    if (!windows.length && !relaxed) {
      $('best').innerHTML = `<h2>No window fits</h2><p>Nothing in the next 3 days fits those limits${Date.now() - forecast.at > 6 * 3600e3 ? ' (and the saved forecast is old; reconnect to refresh it)' : ''}. Try a shorter time or fewer limits.</p>`;
      $('others').innerHTML = ''; return;
    }
    const best = windows[0] && (!relaxed || windows[0].score >= 50) ? windows[0] : relaxed;
    last = { w: best, c, place: place?.name || forecast.for, offset: om.utc_offset_seconds, note: '' };
    renderBest(best, c, hours, nowLocal, relaxed && best === relaxed ? (windows[0] || 'none') : null);
    $('others').innerHTML = windows.filter((w) => w !== best).map((w) => `<div class="alt"><span><strong>${dayName(w.day, nowLocal.slice(0, 10))} ${P.fmt12(w.start)}–${P.fmt12(w.end)}</strong> · ${w.tempMin}–${w.tempMax}°C · rain ≤${w.popMax}%</span><span class="verdict ${P.verdict(w.score)}">${P.verdict(w.score)} (${w.score})</span></div>`).join('') || '<p class="fine">That was the only one.</p>';
    await writeNote(best, c);
  } catch (err) {
    $('out').hidden = false; $('best').innerHTML = `<p>Something went wrong: ${esc(err.message)}</p>`;
  } finally { $('go').disabled = false; $('go').textContent = 'Find my window'; }
};

function renderBest(w, c, hours, nowLocal, roughInside) {
  const day = hours.filter((h) => h.day === w.day);
  const maxPop = 100;
  $('best').innerHTML = `
    ${roughInside === 'none' ? '<div class="warnbox">Nothing fits inside your limits. This is the best time if you can be flexible:</div>' : roughInside ? `<div class="warnbox">Inside your limits the best was only <strong>${P.verdict(roughInside.score)}</strong> (${dayName(roughInside.day, nowLocal.slice(0, 10))} ${P.fmt12(roughInside.start)}, score ${roughInside.score}). This one is outside them but much better:</div>` : ''}
    <span class="verdict ${P.verdict(w.score)}">${P.verdict(w.score)} · ${w.score}/100</span>
    <p class="when">${dayName(w.day, nowLocal.slice(0, 10))}, ${P.fmt12(w.start)} – ${P.fmt12(w.end)}</p>
    <div class="facts"><span>🌡️ ${w.tempMin}–${w.tempMax}°C (feels ${w.feelsMin}–${w.feelsMax})</span><span>🌧️ ≤${w.popMax}%${w.mm ? `, ${w.mm} mm` : ''}</span><span>💨 ≤${w.windMax} km/h</span>${w.sunset ? `<span>🌇 sunset ${P.fmt12(w.sunset)}</span>` : ''}</div>
    ${w.reasons.length ? `<p class="fine">Watch for: ${esc(w.reasons.join(' · '))}</p>` : ''}
    ${w.bonus.length ? `<p class="fine">Why then: ${esc(w.bonus.join(' · '))}</p>` : ''}
    <div class="hours" aria-label="Rain chance by hour">${day.map((h) => { const t = h.time.slice(11, 16); const inW = t >= w.start && t < w.end; return `<div class="${inW ? 'in' : h.daylight ? '' : 'dark'}" style="height:${Math.max(6, 100 - h.pop * 0.9)}%" title="${t} · rain ${h.pop}% · ${h.temp}°C"></div>`; }).join('')}</div>
    <div class="hourlabels"><span>12 AM</span><span>6 AM</span><span>noon</span><span>6 PM</span><span>11 PM</span></div>
    <p class="fine">Taller bar = drier hour. Dark green = your window, grey = dark.</p>
    <div class="note" id="note" aria-live="polite"></div>
    <div class="check fine" id="check"></div>
    <div class="row">
      <button id="ics" class="primary">📅 Add the reminder</button>
      <button id="pocket" class="secondary">💾 Save pocket card</button>
      <button id="leave" class="secondary">🚪 I'm going</button>
    </div>`;
  $('ics').onclick = () => {
    const blob = new Blob([P.toIcs(last.w, last.c, last.place, last.offset, last.note)], { type: 'text/calendar' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `out-the-door-${w.day}-${w.start.replace(':', '')}.ics` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('pocket').onclick = () => { savePocket(); $('pocket').textContent = '✅ Saved (works offline)'; };
  $('leave').onclick = () => { savePocket(); $('gone-when').textContent = `${P.fmt12(w.start)}–${P.fmt12(w.end)}. Bring ${P.packList(w, c).join(', ') || 'just yourself'}.`; $('gone').hidden = false; };
}

async function writeNote(w, c) {
  const el = $('note');
  const useGemma = engine && engineChoice() !== 'none';
  let note;
  if (useGemma) {
    el.textContent = '';
    note = await engine.chat(P.buildNoteMessages(w, c, last.place, forecast.om.latitude), { maxNewTokens: 160, onToken: (t) => { el.textContent += t; } });
    note = note.replace(/\s+/g, ' ').trim();
    const v = P.verifyNote(note, w, c);
    if (v.ok) { el.textContent = note; $('check').textContent = `✓ Written by ${engine.label}. Checked: every time and number matches the forecast.`; }
    else {
      const t = P.templateNote(w, c);
      el.classList.add('flag');
      el.innerHTML = `${esc(t)}<br><span class="fine">Gemma wrote: “${esc(note)}”</span>`;
      $('check').textContent = `⚠️ Gemma's note didn't match the forecast (${v.issues.join('; ')}), so you see the plain version first.`;
      note = t;
    }
  } else {
    note = P.templateNote(w, c);
    el.textContent = note;
    $('check').textContent = 'Plain note from the numbers (load Gemma for a friendlier one).';
  }
  last.note = note;
}

// ---------- pocket card + "did you go?" ----------
function savePocket() { store.set('otd.pocket', { ...last, savedAt: Date.now() }); }
function showPocket() {
  const p = store.get('otd.pocket'); if (!p) return;
  const nowL = new Date(Date.now() + p.offset * 1000).toISOString().slice(0, 16);
  const endL = `${p.w.day}T${p.w.end}`;
  const b = $('pocket-banner'); b.hidden = false;
  const log = store.get('otd.log') || [];
  const weekMin = log.filter((x) => Date.now() - x.at < 7 * 864e5).reduce((a, x) => a + x.min, 0);
  if (nowL < endL) {
    b.innerHTML = `🎒 <strong>${esc(P.ACTIVITIES[p.c.activity].label)}</strong> ${p.w.day === nowL.slice(0, 10) ? 'today' : esc(p.w.day)} ${P.fmt12(p.w.start)}–${P.fmt12(p.w.end)} · ${esc(p.note)} <button id="pc-x" class="secondary">clear</button>`;
  } else {
    b.innerHTML = `Did you go out for that ${esc(P.ACTIVITIES[p.c.activity].label.toLowerCase())} (${P.fmt12(p.w.start)})? <button id="pc-y" class="secondary">Yes</button><button id="pc-n" class="secondary">Not this time</button>${weekMin ? ` · ${weekMin} min outside this week, counted on this device` : ''}`;
    $('pc-y').onclick = () => { log.push({ at: Date.now(), min: p.w.durationMin, a: p.c.activity }); store.set('otd.log', log); localStorage.removeItem('otd.pocket'); b.textContent = `Nice. ${weekMin + p.w.durationMin} min outside this week (counted only on this device).`; };
    $('pc-n').onclick = () => { localStorage.removeItem('otd.pocket'); b.hidden = true; };
  }
  $('pc-x') && ($('pc-x').onclick = () => { localStorage.removeItem('otd.pocket'); b.hidden = true; });
}
$('back').onclick = () => { $('gone').hidden = true; showPocket(); };
showPocket();

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
