// Measures the two Gemma jobs against a hand-labeled set, and compares with the keyword baseline (no model).
//  1. parse: plain-words request -> constraints JSON (samples/requests.json, 20 requests)
//  2. door note: best window -> 3-sentence note, checked by verifyNote()
// Usage: node scripts/gemma-check.mjs [--engine=keyword|ollama|tjs|all] [--ollama-model=gemma4:e2b]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as P from '../src/plan.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const which = (args.engine || 'all').split(',');
const ollamaModel = args['ollama-model'] || 'gemma4:e2b';
const SET = args.set || 'dev';
const REQ = JSON.parse(readFileSync(new URL(SET === 'heldout' ? '../samples/requests-heldout.json' : '../samples/requests.json', import.meta.url)));
const NOTES = !('no-notes' in args);
const FIELDS = ['activity', 'durationMin', 'earliest', 'latest', 'days', 'avoid'];

const engines = [];
if (which.includes('keyword') || which.includes('all')) engines.push({ name: 'keyword baseline (no model)', parse: async (t) => ({ raw: null, c: P.keywordConstraints(t) }) });
const gemmaParse = (chat) => async (t) => {
  const raw = await chat(P.buildParseMessages(t), 120);
  return { raw, c: P.normalizeConstraints(P.extractJson(raw)).constraints, json: !!P.extractJson(raw) };
};
if (which.includes('ollama') || which.includes('all')) {
  const chat = async (messages, n) => {
    const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: ollamaModel, messages, stream: false, think: false, options: { temperature: 0, num_predict: n } }) });
    return (await r.json()).message.content.trim();
  };
  engines.push({ name: `${ollamaModel} (Ollama, CPU)`, parse: gemmaParse(chat), chat });
}
if (which.includes('tjs') || which.includes('all')) {
  const { pipeline, env } = await import('@huggingface/transformers');
  if (process.env.TJS_CACHE) env.cacheDir = process.env.TJS_CACHE;
  const gen = await pipeline('text-generation', 'onnx-community/gemma-3-1b-it-ONNX', { dtype: 'q4' });
  const chat = async (messages, n) => (await gen(messages, { max_new_tokens: n, do_sample: false }))[0].generated_text.at(-1).content.trim();
  engines.push({ name: 'gemma-3-1b-it (ONNX q4, Transformers.js, CPU) — the in-browser model', parse: gemmaParse(chat), chat });
}

// Door-note cases: real forecasts saved on 2026-10-05.
const load = (f) => JSON.parse(readFileSync(new URL(`../samples/${f}-2026-10-05.json`, import.meta.url)));
const NOTE_CASES = [
  ['seattle', 'Seattle, WA', '2026-10-05T13:50', { activity: 'walk', durationMin: 45, earliest: null, latest: null, days: 'today', avoid: [] }],
  ['seattle', 'Seattle, WA', '2026-10-05T13:50', { activity: 'birding', durationMin: 120, earliest: null, latest: null, days: 'tomorrow', avoid: [] }],
  ['seattle', 'Seattle, WA', '2026-10-05T13:50', { activity: 'foliage', durationMin: 90, earliest: null, latest: null, days: 'next3', avoid: [] }],
  ['bergen', 'Bergen, Norway', '2026-10-05T08:00', { activity: 'walk', durationMin: 60, earliest: null, latest: null, days: 'next3', avoid: ['rain'] }],
  ['phoenix', 'Phoenix, AZ', '2026-10-05T13:50', { activity: 'run', durationMin: 40, earliest: null, latest: null, days: 'next3', avoid: ['heat'] }],
  ['phoenix', 'Phoenix, AZ', '2026-10-05T13:50', { activity: 'garden', durationMin: 60, earliest: null, latest: null, days: 'tomorrow', avoid: ['sun'] }],
];

const eq = (f, a, b) => f === 'avoid' ? JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort()) : (a ?? null) === (b ?? null);
const report = { date: new Date().toISOString(), set: SET, requests: REQ.length, engines: [] };
for (const eng of engines) {
  const rows = [];
  const fieldOk = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let exact = 0, jsonOk = 0, ms = 0;
  for (const { text, expect } of REQ) {
    const t0 = Date.now();
    const { raw, c, json } = await eng.parse(text);
    const dt = Date.now() - t0; ms += dt;
    // A null duration in the label means "not said": the right answer is the activity default.
    const exp = { ...expect, durationMin: expect.durationMin ?? P.ACTIVITIES[expect.activity].defaultMin };
    const wrong = FIELDS.filter((f) => !eq(f, c[f], exp[f]));
    FIELDS.forEach((f) => { if (!wrong.includes(f)) fieldOk[f]++; });
    if (!wrong.length) exact++;
    if (json || raw === null) jsonOk++;
    rows.push({ text, got: c, wrong, raw, ms: dt });
    console.log(`[${eng.name}] ${wrong.length ? 'MISS ' + wrong.join(',') : 'ok  '} | ${text}${wrong.length ? `\n     got ${JSON.stringify(c)}` : ''}`);
  }
  const notes = [];
  if (eng.chat && NOTES) {
    for (const [f, place, now, c] of NOTE_CASES) {
      const om = load(f);
      const w = P.findWindows(P.toHours(om), c, { nowLocal: now })[0];
      const t0 = Date.now();
      const note = (await eng.chat(P.buildNoteMessages(w, c, place, om.latitude), 160)).replace(/\s+/g, ' ');
      const v = P.verifyNote(note, w, c);
      notes.push({ place, activity: c.activity, window: `${w.day} ${w.start}-${w.end}`, score: w.score, note, ok: v.ok, issues: v.issues, ms: Date.now() - t0 });
      console.log(`  note ${v.ok ? 'PASS' : 'FAIL'} ${place} ${c.activity} ${w.start}: ${note}${v.ok ? '' : `\n     ${v.issues.join(' | ')}`}`);
    }
  }
  report.engines.push({
    engine: eng.name,
    exactMatch: `${exact}/${REQ.length}`,
    fieldAccuracy: Object.fromEntries(FIELDS.map((f) => [f, `${fieldOk[f]}/${REQ.length}`])),
    validJson: `${jsonOk}/${REQ.length}`,
    avgParseMs: Math.round(ms / REQ.length),
    notesPassingVerifier: eng.chat && NOTES ? `${notes.filter((n) => n.ok).length}/${notes.length}` : null,
    rows, notes,
  });
}
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
const out = new URL(`../results/gemma-check-${SET}-${which.join('-')}.json`, import.meta.url);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log('\nSUMMARY', JSON.stringify(report.engines.map(({ rows, notes, ...r }) => r), null, 1));
