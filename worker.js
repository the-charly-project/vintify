/* worker.js — tutto il lavoro pesante gira qui, fuori dal thread dell'interfaccia.
 * Nessun upload: l'immagine resta nel browser (elemento <input file> locale).
 */

import { removeBackground } from './vendor/imgly-loader.mjs';
import { processAll } from './pipeline.js';

const post = (m, t) => self.postMessage(m, t);
const tick = () => new Promise((r) => setTimeout(r, 0));

function bitmapToRGBA(bitmap, maxSide = 1600) {
  let w = bitmap.width, h = bitmap.height;
  let scale = 1;
  if (Math.max(w, h) > maxSide) scale = maxSide / Math.max(w, h);
  if (scale < 1) { w = Math.round(w * scale); h = Math.round(h * scale); }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { data: img.data, width: w, height: h };
}

async function rgbaToBitmap(rgba) {
  const canvas = new OffscreenCanvas(rgba.width, rgba.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  return canvas.transferToImageBitmap();
}

self.onmessage = async (e) => {
  const { file, opts } = e.data || {};
  if (!file) return;
  try {
    post({ type: 'progress', msg: 'Apro la foto…' });
    const srcBitmap = await createImageBitmap(file);

    post({ type: 'progress', msg: 'Isolo il prodotto (AI)…' });
    let cutBlob;
    let announced = false;
    cutBlob = await removeBackground(file, {
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        if (key.startsWith('fetch')) {
          announced = true;
          const pct = total ? Math.round((current / total) * 100) : 0;
          post({ type: 'progress', msg: `Scarico il modello AI… ${pct}% (solo la prima volta)` });
        }
      },
      // se vuoi servire tutto dal tuo dominio (100% offline) imposta publicPath
      // publicPath: '/modello/',
    });
    if (!announced) post({ type: 'progress', msg: 'Prodotto isolato ✔' });

    const cutBitmap = await createImageBitmap(cutBlob);
    const cut = bitmapToRGBA(cutBitmap, 1600);
    const orig = bitmapToRGBA(srcBitmap, 1400);
    await tick();

    post({ type: 'progress', msg: 'Correggo colore e luce, distendo le pieghe…' });
    await tick();
    const res = processAll(cut, orig, {
      canvas: opts.canvas || 1600,
      mode: opts.mode || 'full',
      folds: opts.folds ?? 0.65,
      product: opts.product || 'clothing',
    });
    await tick();

    post({ type: 'progress', msg: 'Costruisco gli sfondi…' });
    const white = await rgbaToBitmap(res.white);
    const original = await rgbaToBitmap(res.originalBg);
    post({ type: 'done', white, original, steps: res.steps, ms: res.ms }, [white, original]);
  } catch (err) {
    post({ type: 'error', msg: (err && err.message) ? err.message : String(err) });
  }
};
