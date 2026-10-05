// Three ways to read your request. Two run Gemma on hardware you control; the third uses no model at all.
import { keywordConstraints, normalizeConstraints, extractJson, buildParseMessages } from './plan.js';

export class BrowserGemma {
  constructor({ onProgress } = {}) {
    this.kind = 'browser';
    this.label = 'Gemma 3 1B in this browser';
    this.worker = new Worker(new URL('./gemma-worker.js', import.meta.url), { type: 'module' });
    this.jobs = new Map(); this.seq = 0;
    this.worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') onProgress?.(m.p);
      else if (m.type === 'ready') { this.label = `Gemma 3 1B in this browser (${m.device === 'webgpu' ? 'WebGPU' : 'CPU'})`; this._ok?.(m); }
      else if (m.type === 'token') this.jobs.get(m.id)?.onToken?.(m.t);
      else if (m.type === 'done') { this.jobs.get(m.id)?.resolve(m.text); this.jobs.delete(m.id); }
      else if (m.type === 'error') { const j = this.jobs.get(m.id); if (j) { j.reject(new Error(m.error)); this.jobs.delete(m.id); } else this._bad?.(new Error(m.error)); }
    };
  }
  load(device) { return new Promise((ok, bad) => { this._ok = ok; this._bad = bad; this.worker.postMessage({ type: 'load', device }); }); }
  chat(messages, { onToken, maxNewTokens = 160 } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.jobs.set(id, { resolve, reject, onToken }); this.worker.postMessage({ type: 'chat', id, messages, maxNewTokens }); });
  }
}

export class OllamaGemma {
  constructor({ baseUrl = 'http://localhost:11434', model = 'gemma4:e2b' } = {}) {
    this.kind = 'ollama'; this.baseUrl = baseUrl.replace(/\/$/, ''); this.model = model;
    this.label = `${model} via Ollama on your computer`;
  }
  async load() {
    const r = await fetch(`${this.baseUrl}/api/tags`);
    if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
    const { models = [] } = await r.json();
    if (!models.some((m) => m.name === this.model || m.model === this.model)) throw new Error(`No ${this.model} yet. Run: ollama pull ${this.model}`);
  }
  async chat(messages, { onToken, maxNewTokens = 200 } = {}) {
    const r = await fetch(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, messages, stream: true, think: false, options: { temperature: 0, num_predict: maxNewTokens } }) });
    if (!r.ok || !r.body) throw new Error(`Ollama error ${r.status}`);
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const t = JSON.parse(line).message?.content || '';
        if (t) { text += t; onToken?.(t); }
      }
    }
    return text.trim();
  }
}

/** Read a request with Gemma if loaded; otherwise (or if Gemma's JSON is unusable) with keyword rules. */
export async function readRequest(engine, text) {
  if (!engine) return { constraints: keywordConstraints(text), repairs: [], source: 'keyword rules (no model loaded)' };
  // Measured: Gemma 3 1B got 0 of 32 test requests fully right (it invents time limits and copies the example's "avoid"),
  // while Gemma 4 E2B got 20 of 32. So the 1B in-browser model only writes the door note; reading needs Gemma 4.
  if (engine.kind === 'browser') return { constraints: keywordConstraints(text), repairs: [], source: 'keyword rules (Gemma 3 1B writes the note; for Gemma to read your request, use Gemma 4 via Ollama)' };
  const raw = await engine.chat(buildParseMessages(text), { maxNewTokens: 120 });
  const json = extractJson(raw);
  if (!json) return { constraints: keywordConstraints(text), repairs: ['Gemma did not return JSON, so keyword rules were used'], source: 'keyword rules (fallback)', raw };
  const { constraints, repairs } = normalizeConstraints(json);
  return { constraints, repairs, source: engine.label, raw };
}
