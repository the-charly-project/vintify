/* worker.js — tutto il lavoro pesante gira qui, fuori dal thread dell'interfaccia.
 *
 * Due motori:
 *   CLASSICO  : ritaglio AI + ritocco matematico (istantaneo, offline, nessun upload)
 *   AI        : come sopra, poi RIFINITURA GENERATIVA su Stable Horde (rete volontaria,
 *               chiave anonima "0000000000", nessun login): l'AI ridisegna il prodotto
 *               togliendo pieghe e imperfezioni, poi il risultato viene ritagliato di nuovo
 *               e ricomposto con sfondo studio + ombra.
 *
 * NOTA (bug corretto il 4/10/2026): la libreria era salvata in locale con
 * `import("onnxruntime-web")` — uno specificatore "nudo" che il browser non risolve
 * ("Failed to resolve module specifier"). La build `+esm` di jsDelivr riscrive quei
 * percorsi in URL assoluti: va caricata da lì.
 */

import { removeBackground } from 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
import { processAll } from './pipeline.js';

const HORDE = 'https://stablehorde.net/api/v2';
const ANON_KEY = '0000000000';           // chiave anonima ufficiale: nessun account
const CLIENT_AGENT = 'vintify:1.0:(https://github.com/the-charly-project/vintify)';

const post = (m, t) => self.postMessage(m, t);
const tick = () => new Promise((r) => setTimeout(r, 0));

function bitmapToRGBA(bitmap, maxSide = 1600) {
  let w = bitmap.width, h = bitmap.height, scale = 1;
  if (Math.max(w, h) > maxSide) scale = maxSide / Math.max(w, h);
  if (scale < 1) { w = Math.round(w * scale); h = Math.round(h * scale); }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}

async function rgbaToBitmap(rgba) {
  const canvas = new OffscreenCanvas(rgba.width, rgba.height);
  canvas.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  return canvas.transferToImageBitmap();
}

function rgbaToBlob(rgba) {
  const canvas = new OffscreenCanvas(rgba.width, rgba.height);
  canvas.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/* ---------------------------------------------------------------- prompt per l'AI
 * Due strategie:
 *   fedele   → l'AI ritocca senza reinventare (posa e dettagli restano quelli della foto)
 *   catalogo → l'AI reimmagina il prodotto "da catalogo" (più bello, ma può inventare dettagli)
 */
function buildPrompts(opts) {
  const desc = (opts.description || '').trim();
  const subject = desc || (opts.product === 'object' ? 'the product' : 'the garment');

  const negative = [
    // imperfezioni da rimuovere
    'wrinkles, creases, crumpled, crinkled fabric, stains, dirt, dust, scratches, scuffs, damage, worn',
    // difetti tecnici
    'blurry, out of focus, low quality, low resolution, jpeg artifacts, oversaturated, deformed, distorted shape, warped edges, duplicates',
    // cose che NON vogliamo inventate
    'text, lettering, typography, label, tag, brand name, logo, embroidery, printed words, price tag',
    'watermark, signature, human, hands, face, mannequin, extra objects, busy background',
  ].join(', ');

  if (opts.aiMode === 'fedele') {
    return {
      prompt: [
        `professional product photo of exactly the same ${subject} shown in the input image`,
        'same shape, same position, same design details, identical buttons, pockets and proportions',
        'fabric clean, smooth and pressed, colors true to the original',
        'bright even studio lighting, soft shadow, clean pure white background, sharp focus, photorealistic',
      ].join(', '),
      negative,
    };
  }

  return {
    prompt: [
      `professional e-commerce catalogue photo of ${subject}`,
      'neatly arranged and gently folded like on a shop display, fabric perfectly smooth and pressed like new',
      'crisp clean stitching, vivid true colors, bright even studio lighting, soft shadows',
      'sharp focus, high detail, photorealistic, clean pure white background, retail quality listing photo',
    ].join(', '),
    negative,
  };
}

/* ---------------------------------------------------------------- Stable Horde */
async function hordeRefine(dataUrl, opts, onStatus) {
  const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const { prompt, negative } = buildPrompts(opts);

  const payload = {
    prompt,
    params: {
      sampler_name: 'k_euler', cfg_scale: 5.0,
      width: 1024, height: 1024, steps: 26, n: 1, karras: true,
    },
    negative_prompt: negative,
    source_image: b64,
    source_processing: 'img2img',
    denoising_strength: opts.aiStrength ?? 0.45,
    nsfw: false,
    censor_nsfw: false,
    models: ['Juggernaut XL'],
    r2: false,                       // immagine in base64 nella risposta: nessuna CORS extra
  };

  onStatus('Invio alla rete AI…');
  const res = await fetch(`${HORDE}/generate/async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, 'Client-Agent': CLIENT_AGENT },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Horde ha rifiutato la richiesta (${res.status})`);
  const { id, message } = await res.json();
  if (!id) throw new Error(message || 'Nessun id dal generatore');

  const t0 = Date.now();
  const MAX_WAIT = 15 * 60 * 1000;
  while (Date.now() - t0 < MAX_WAIT) {
    await new Promise((r) => setTimeout(r, 6000));
    const c = await (await fetch(`${HORDE}/generate/check/${id}`, { headers: { apikey: ANON_KEY, 'Client-Agent': CLIENT_AGENT } })).json();
    if (c.faulted) throw new Error('Il worker AI ha fallito: ' + (c.message || 'errore sconosciuto'));
    if (c.done) break;
    const pos = c.queue_position;
    onStatus(c.processing ? 'L\'AI sta ridisegnando il prodotto…'
                          : `In coda AI — posizione ${pos}${c.waiting ? ` (${c.waiting} lavori avanti)` : ''}…`);
  }
  if (Date.now() - t0 >= MAX_WAIT) throw new Error('Coda AI troppo lunga: ripiega sull\'elaborazione classica');

  onStatus('Scarico il risultato AI…');
  const st = await (await fetch(`${HORDE}/generate/status/${id}`, { headers: { apikey: ANON_KEY, 'Client-Agent': CLIENT_AGENT } })).json();
  const gen = (st.generations || [])[0];
  if (!gen || !gen.img) throw new Error('Nessuna immagine restituita dall\'AI');
  const img = gen.img;
  if (img.startsWith('http')) {
    return await (await fetch(img)).blob();
  }
  const bin = atob(img);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/webp' });
}

/* ---------------------------------------------------------------- flusso principale */
self.onmessage = async (e) => {
  const { file, opts } = e.data || {};
  if (!file) return;
  const steps = [];
  try {
    post({ type: 'progress', msg: 'Apro la foto…' });
    const srcBitmap = await createImageBitmap(file);

    post({ type: 'progress', msg: 'Isolo il prodotto (AI)…' });
    const cutBlob = await removeBackground(file, {
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        if (key.startsWith('fetch')) {
          const pct = total ? Math.round((current / total) * 100) : 0;
          post({ type: 'progress', msg: `Scarico il modello AI… ${pct}% (solo la prima volta)` });
        }
      },
    });
    steps.push('isolamento del prodotto (AI)');

    const cutBitmap = await createImageBitmap(cutBlob);
    const cut = bitmapToRGBA(cutBitmap, 1600);
    const orig = bitmapToRGBA(srcBitmap, 1400);
    await tick();

    /* --- immagini di partenza, in base al motore scelto --- */
    let productRGBA, enhSteps;

    if (opts.engine === 'ai') {
      // 1. prodotto pulito su tela bianca 1024 → è ciò che l'AI ridisegna
      post({ type: 'progress', msg: 'Preparo il prodotto per la rifinitura AI…' });
      const base = processAll(cut, orig, { canvas: 1024, mode: 'light', folds: 0.2, product: opts.product });
      steps.push(...base.steps.filter((s) => !steps.includes(s)));

      const baseUrl = await new Promise((resolve) => {
        const canvas = new OffscreenCanvas(base.white.width, base.white.height);
        canvas.getContext('2d').putImageData(new ImageData(base.white.data, base.white.width, base.white.height), 0, 0);
        canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 }).then((blob) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.readAsDataURL(blob);
        });
      });

      // 2. rifinitura generativa sulla rete volontaria
      const refinedBlob = await hordeRefine(baseUrl, opts, (msg) => post({ type: 'progress', msg }));
      steps.push('rifinitura generativa (Stable Horde)');

      // 3. il risultato AI viene ritagliato di nuovo e ricomposto con lo sfondo studio
      post({ type: 'progress', msg: 'Ritaglio il risultato AI…' });
      const refinedCut = await removeBackground(refinedBlob, { output: { format: 'image/png' } });
      const refinedBitmap = await createImageBitmap(refinedCut);
      const refined = processAll(bitmapToRGBA(refinedBitmap, 1600), orig, {
        canvas: opts.canvas || 1600, mode: 'light', folds: 0.12, product: opts.product,
      });
      productRGBA = refined.white ? refined : null;
      enhSteps = refined.steps;
      steps.push('ricomposizione studio');
      const aiWhite = await rgbaToBitmap(refined.white);
      const aiOrig = await rgbaToBitmap(refined.originalBg);
      post({ type: 'done', white: aiWhite, original: aiOrig, steps, engine: 'ai' }, [aiWhite, aiOrig]);
      return;
    }

    /* --- motore classico --- */
    post({ type: 'progress', msg: 'Correggo colore e luce, distendo le pieghe…' });
    await tick();
    const res = processAll(cut, orig, {
      canvas: opts.canvas || 1600,
      mode: opts.mode || 'full',
      folds: opts.folds ?? 0.65,
      product: opts.product || 'clothing',
    });
    steps.push(...res.steps.filter((s) => !steps.includes(s)));

    post({ type: 'progress', msg: 'Costruisco gli sfondi…' });
    const white = await rgbaToBitmap(res.white);
    const original = await rgbaToBitmap(res.originalBg);
    post({ type: 'done', white, original, steps, engine: 'classic' }, [white, original]);
  } catch (err) {
    post({ type: 'error', msg: (err && err.message) ? err.message : String(err), steps });
  }
};
