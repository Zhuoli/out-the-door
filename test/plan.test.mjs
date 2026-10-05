import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../src/plan.js';

const load = (f) => P.toHours(JSON.parse(readFileSync(new URL(`../samples/${f}-2026-10-05.json`, import.meta.url))));
const SEA = load('seattle'), BGO = load('bergen'), PHX = load('phoenix');
const om = JSON.parse(readFileSync(new URL('../samples/seattle-2026-10-05.json', import.meta.url)));

test('extractJson handles fences and prose', () => {
  assert.deepEqual(P.extractJson('Sure!\n```json\n{"activity":"run","x":{"y":"}"}}\n```'), { activity: 'run', x: { y: '}' } });
  assert.equal(P.extractJson('no json here'), null);
  assert.equal(P.extractJson('{"broken": '), null);
});

test('normalizeConstraints repairs bad model output', () => {
  const { constraints: c, repairs } = P.normalizeConstraints({ activity: 'skydiving', durationMin: 9999, earliest: '25:00', latest: '17:00', days: 'someday', avoid: ['rain', 'bees'] });
  assert.equal(c.activity, 'walk');
  assert.equal(c.durationMin, 600);
  assert.equal(c.earliest, null);
  assert.equal(c.latest, '17:00');
  assert.equal(c.days, 'next3');
  assert.deepEqual(c.avoid, ['rain']);
  assert.ok(repairs.length >= 5);
  assert.equal(P.normalizeConstraints({ activity: 'run', earliest: '18:00', latest: '07:00' }).constraints.earliest, null);
  assert.equal(P.normalizeConstraints(null).constraints.durationMin, 45);
  assert.deepEqual(P.normalizeConstraints({ activity: 'stars', avoid: ['dark', 'wind'] }).constraints.avoid, ['wind']);
  assert.equal(P.normalizeConstraints({ activity: 'bike', earliest: '00:00', latest: '23:59' }).constraints.earliest, null);
});

test('keyword baseline', () => {
  const c = P.keywordConstraints('45 min walk with the dog before dark, I hate wind');
  assert.equal(c.activity, 'walk'); assert.equal(c.durationMin, 45); assert.deepEqual(c.avoid.sort(), ['dark', 'wind']);
  assert.equal(P.keywordConstraints('1.5 hours of birding tomorrow').durationMin, 90);
  assert.equal(P.keywordConstraints('birding tomorrow').days, 'tomorrow');
  assert.equal(P.keywordConstraints('run after work').earliest, '17:00');
});

test('toHours reads Open-Meteo and marks daylight from sunrise/sunset', () => {
  assert.equal(SEA.length, 72);
  const h = (t) => SEA.find((x) => x.time === t);
  assert.equal(h('2026-10-05T03:00').daylight, false);
  assert.equal(h('2026-10-05T12:00').daylight, true);
  assert.equal(h('2026-10-05T19:00').daylight, false); // sunset 18:40, hour would end 20:00
});

test('never suggests a window that already started, or outside the limits', () => {
  const c = { activity: 'walk', durationMin: 45, earliest: '15:00', latest: '18:00', days: 'today', avoid: [] };
  const w = P.findWindows(SEA, c, { nowLocal: '2026-10-05T13:50' });
  assert.ok(w.length);
  for (const x of w) { assert.equal(x.day, '2026-10-05'); assert.ok(x.start >= '15:00'); assert.ok(P.toMin(x.end) <= P.toMin('18:00')); }
  const all = P.findWindows(SEA, { ...c, earliest: null, latest: null }, { nowLocal: '2026-10-05T13:50', top: 50 });
  assert.ok(all.every((x) => x.start >= '14:00'));
});

test('windows never overlap and daylight activities stay in daylight', () => {
  const c = { activity: 'hike', durationMin: 180, earliest: null, latest: null, days: 'next3', avoid: [] };
  const w = P.findWindows(SEA, c, { nowLocal: '2026-10-05T08:00', top: 5 });
  for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) {
    if (w[i].day !== w[j].day) continue;
    assert.ok(P.toMin(w[i].end) <= P.toMin(w[j].start) || P.toMin(w[j].end) <= P.toMin(w[i].start));
  }
  const hrs = (x) => SEA.filter((h) => h.day === x.day && h.time.slice(11, 16) >= x.start && h.time.slice(11, 16) < x.end);
  assert.ok(w.every((x) => hrs(x).every((h) => h.daylight)));
});

test('stargazing only at night', () => {
  const w = P.findWindows(SEA, { activity: 'stars', durationMin: 60, earliest: null, latest: null, days: 'next3', avoid: [] }, { nowLocal: '2026-10-05T13:50' });
  assert.ok(w.length && w.every((x) => !SEA.find((h) => h.day === x.day && h.time.endsWith(x.start)).daylight));
});

test('rain sinks a window; heat pushes a Phoenix run to the morning', () => {
  const walk = { activity: 'walk', durationMin: 45, earliest: null, latest: null, days: 'next3', avoid: ['rain'] };
  const bergen = P.findWindows(BGO, walk, { nowLocal: '2026-10-05T08:00' })[0];
  const seattle = P.findWindows(SEA, walk, { nowLocal: '2026-10-05T08:00' })[0];
  assert.ok(bergen.score < 40, `bergen ${bergen.score}`);
  assert.ok(seattle.score >= 80, `seattle ${seattle.score}`);
  const run = { activity: 'run', durationMin: 40, earliest: '17:00', latest: null, days: 'today', avoid: [] };
  const r = P.plan(PHX, run, { nowLocal: '2026-10-05T13:50' });
  assert.ok(r.windows[0].score < 50);
  assert.ok(r.relaxed && r.relaxed.start < '09:00', JSON.stringify(r.relaxed));
});

test('birding prefers early morning', () => {
  const w = P.findWindows(SEA, { activity: 'birding', durationMin: 120, earliest: null, latest: null, days: 'tomorrow', avoid: [] }, { nowLocal: '2026-10-05T13:50' })[0];
  assert.equal(w.start, '07:00');
  assert.ok(w.bonus.length);
});

test('verifyNote accepts a faithful note and catches invented times/numbers', () => {
  const c = { activity: 'walk', durationMin: 45, earliest: null, latest: null, days: 'today', avoid: [] };
  const w = P.findWindows(SEA, c, { nowLocal: '2026-10-05T13:50' })[0];
  const good = P.templateNote(w, c);
  assert.equal(P.verifyNote(good, w, c).ok, true, JSON.stringify(P.verifyNote(good, w, c)));
  const bad = `Leave at 3:15 PM, it'll be 30 degrees. Bring an umbrella for the rain.`;
  const v = P.verifyNote(bad, w, c);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.includes('3:15')));
  assert.ok(v.issues.some((i) => i.includes('30')));
  assert.ok(v.issues.some((i) => i.includes('rain')));
  assert.equal(P.verifyNote(`Head out at ${P.fmt12(w.start)}; no rain expected.`, w, c).ok, true);
});

test('ics converts local time to UTC with a reminder', () => {
  const c = { activity: 'walk', durationMin: 45, earliest: null, latest: null, days: 'today', avoid: [] };
  const w = { day: '2026-10-05', start: '16:00', end: '16:45', durationMin: 45 };
  const ics = P.toIcs(w, c, 'Seattle, WA', om.utc_offset_seconds, 'Go, see you later; bring a fleece');
  assert.match(ics, /DTSTART:20261005T230000Z/);
  assert.match(ics, /DTEND:20261005T234500Z/);
  assert.match(ics, /TRIGGER:-PT15M/);
  assert.match(ics, /DESCRIPTION:Go\\, see you later\\; bring a fleece/);
});

test('pack list comes from numbers', () => {
  const w = { popMax: 60, mm: 1, feelsMin: 7, feelsMax: 10, uvMax: 1, gustMax: 40, durationMin: 60, end: '12:00', sunset: '18:40' };
  const p = P.packList(w, { activity: 'birding' });
  assert.ok(p.includes('rain shell') && p.includes('binoculars') && p.includes('warm layer and gloves'));
});
