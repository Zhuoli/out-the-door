// Gemma 3 1B inside the browser (Web Worker) with Transformers.js. WebGPU if the device has it, WebAssembly otherwise.
// After the first download the weights sit in the browser cache, so this works with no signal.
import { pipeline, TextStreamer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

env.allowLocalModels = false;
const MODEL_ID = 'onnx-community/gemma-3-1b-it-ONNX';
const CPU_DTYPE = 'int8'; // the q4 export needs an op the WASM backend lacks
let gen = null, cfg = null;

async function chooseDevice() {
  try {
    const a = self.navigator?.gpu && await self.navigator.gpu.requestAdapter();
    if (a) return { device: 'webgpu', dtype: a.features.has('shader-f16') ? 'q4f16' : 'q4' };
  } catch { /* use CPU */ }
  return { device: 'wasm', dtype: CPU_DTYPE };
}

async function load(c) {
  cfg = c;
  gen = await pipeline('text-generation', MODEL_ID, {
    device: c.device, dtype: c.dtype,
    ...(c.dtype === CPU_DTYPE ? { use_external_data_format: false } : {}),
    progress_callback: (p) => self.postMessage({ type: 'progress', p }),
  });
  await gen([{ role: 'user', content: 'Say OK.' }], { max_new_tokens: 2, do_sample: false }); // fail now, not on first use
}

self.onmessage = async ({ data }) => {
  const { type, id, messages, maxNewTokens = 160, device } = data;
  try {
    if (type === 'load') {
      const c = device ? { device, dtype: device === 'wasm' ? CPU_DTYPE : 'q4' } : await chooseDevice();
      try { await load(c); } catch (e) {
        if (c.device !== 'webgpu') throw e;
        self.postMessage({ type: 'progress', p: { status: 'fallback', message: String(e?.message || e) } });
        await load({ device: 'wasm', dtype: CPU_DTYPE });
      }
      self.postMessage({ type: 'ready', device: cfg.device, dtype: cfg.dtype });
    } else if (type === 'chat') {
      const streamer = new TextStreamer(gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (t) => self.postMessage({ type: 'token', id, t }) });
      const out = await gen(messages, { max_new_tokens: maxNewTokens, do_sample: false, streamer });
      self.postMessage({ type: 'done', id, text: out[0].generated_text.at(-1).content.trim() });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id, error: String(e?.message || e) });
  }
};
