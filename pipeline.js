/* pipeline.js — Vintify: da foto amatoriale a foto da catalogo, TUTTO nel browser.
 *
 * Nessun server: queste funzioni lavorano su {data: Uint8ClampedArray, width, height}
 * con dati RGBA. Sono volutamente senza dipendenze DOM così possono girare anche in
 * un Web Worker (e nei test con Node).
 *
 * Passi: bilanciamento del bianco (sfondo come illuminante) -> luci/ombre ->
 *        luce uniforme -> distensione pieghe (+ trama tessuto) -> nitidezza -> saturazione
 *        -> composizione su sfondo bianco studio / originale sfocato (con ombra di contatto).
 */

/* ------------------------------------------------------------------ blur */
function boxBlurH(src, dst, w, h, r) {
  const norm = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * norm;
      const outIdx = Math.min(w - 1, Math.max(0, x - r));
      const inIdx = Math.min(w - 1, Math.max(0, x + r + 1));
      sum += src[row + inIdx] - src[row + outIdx];
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const norm = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm;
      const outIdx = Math.min(h - 1, Math.max(0, y - r));
      const inIdx = Math.min(h - 1, Math.max(0, y + r + 1));
      sum += src[inIdx * w + x] - src[outIdx * w + x];
    }
  }
}

/** Approssimazione gaussiana con 3 passaggi di box blur (O(n), separabile). */
function gauss(src, w, h, sigma) {
  if (sigma <= 0.4) return Float32Array.from(src);
  const r = Math.max(1, Math.round(Math.sqrt(12 * sigma * sigma / 3 + 1) / 2));
  let a = Float32Array.from(src);
  let b = new Float32Array(w * h);
  for (let i = 0; i < 3; i++) {
    boxBlurH(a, b, w, h, r); boxBlurV(b, a, w, h, r);
  }
  return a;
}

/* ------------------------------------------------------------------ util */
function channel(rgba, ch, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = rgba[p + ch];
  return out;
}

function maskFromAlpha(rgba, w, h) {
  const m = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < m.length; i++, p += 4) m[i] = rgba[p] > 127 ? 1 : 0;
  return m;
}

function histMedian(vals) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < vals.length; i++) hist[Math.max(0, Math.min(255, vals[i] | 0))]++;
  const target = vals.length / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 128;
}

function histPercentile(vals, q) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < vals.length; i++) hist[Math.max(0, Math.min(255, vals[i] | 0))]++;
  const target = vals.length * q;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

/* ------------------------------------------------------------------ ritocco */
export function enhance(rgba, w, h, opts = {}) {
  const o = Object.assign({
    whiteBalance: true, liftShadows: true, flattenLighting: 0.9,
    smoothFolds: 0.65, keepTexture: 0.35, sharpen: 0.30,
    saturation: 1.05, scale: 1.0,   // scale: fattore di ridimensionamento rispetto ai sigma tarati a 1400px
  }, opts);
  const f = Math.max(0.35, o.scale);

  const a = new Uint8ClampedArray(rgba);
  const mask = maskFromAlpha(rgba, w, h);
  const n = w * h;

  /* --- 1. bilanciamento del bianco: lo sfondo (o i pixel neutri) come illuminante --- */
  if (o.whiteBalance) {
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    const satOf = (p) => {
      const r = a[p], g = a[p + 1], b = a[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mx === 0 ? 0 : (mx - mn) / mx;
    };
    // prima scelta: sfondo (alpha basso) poco saturo
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (a[p + 3] < 40 && satOf(p) < 0.24) { sr += a[p]; sg += a[p + 1]; sb += a[p + 2]; cnt++; }
    }
    if (cnt < 300) {  // fallback: pixel più neutri del prodotto
      sr = sg = sb = cnt = 0;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        if (a[p + 3] > 127 && satOf(p) <= 0.14) { sr += a[p]; sg += a[p + 1]; sb += a[p + 2]; cnt++; }
      }
    }
    if (cnt > 100) {
      const mr = sr / cnt, mg = sg / cnt, mb = sb / cnt;
      const mean = (mr + mg + mb) / 3;
      if (Math.max(mr, mg, mb) > 25) {
        const cl = (v) => Math.min(1.16, Math.max(0.86, v));
        const gr = cl(mean / Math.max(1e-6, mr)), gg = cl(mean / Math.max(1e-6, mg)), gb = cl(mean / Math.max(1e-6, mb));
        for (let p = 0; p < a.length; p += 4) {
          a[p] = Math.min(255, a[p] * gr); a[p + 1] = Math.min(255, a[p + 1] * gg); a[p + 2] = Math.min(255, a[p + 2] * gb);
        }
      }
    }
  }

  /* --- luminanza di lavoro (Lab-like: usiamo il canale L stimato) --- */
  const L = channel(a, 0, w, h);  // useremo una luminanza vera, più avanti
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    L[i] = 0.299 * a[p] + 0.587 * a[p + 1] + 0.114 * a[p + 2];
  }
  const prodVals = [];
  for (let i = 0; i < n; i++) if (mask[i]) prodVals.push(L[i]);

  /* --- 2. luci e ombre --- */
  if (o.liftShadows && prodVals.length > 200) {
    const lo = histPercentile(prodVals, 0.02), hi = histPercentile(prodVals, 0.995);
    const med = histMedian(prodVals);
    if (hi - lo > 40 && med < 165) {
      const tlo = lo * 0.35, span = Math.max(60, hi - tlo);
      for (let i = 0; i < n; i++) {
        const st = Math.min(255, Math.max(0, (L[i] - tlo) * (255 / span)));
        L[i] = L[i] + (st - L[i]) * 0.5;
      }
    }
    for (let i = 0; i < n; i++) L[i] = 255 * Math.pow(Math.max(0, Math.min(255, L[i])) / 255, 0.94);
  }

  /* --- 3. luce uniforme --- */
  if (o.flattenLighting > 0) {
    const illum = gauss(L, w, h, 110 * f);
    const ref = histMedian(prodVals.length ? prodVals : [128]);
    const mSoft = gauss(Float32Array.from(mask, (v) => v), w, h, 2.5 * f);
    for (let i = 0; i < n; i++) {
      let corr = ref / Math.max(1e-3, illum[i]);
      corr = Math.min(1.30, Math.max(0.80, corr));
      corr = 1 + (corr - 1) * o.flattenLighting;
      const mm = Math.min(1, mSoft[i]);
      L[i] = L[i] * (1 - mm) + (L[i] * corr) * mm;
    }
  }

  /* --- 4. distensione pieghe (banda di frequenza) + trama --- */
  if (o.smoothFolds > 0) {
    const s = Math.min(1, Math.max(0, o.smoothFolds));
    const bFine = gauss(L, w, h, 2.2 * f);
    const l1 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let d = L[i] - bFine[i];
      d = d < 0 ? d * (1 - 0.55 * s) : d * (1 - 0.10 * s);
      l1[i] = bFine[i] + d;
    }
    const bMid = gauss(l1, w, h, 7 * f);
    const bBig = gauss(l1, w, h, 26 * f);
    const l2 = new Float32Array(n);
    for (let i = 0; i < n; i++) l2[i] = bBig[i] + (bMid[i] - bBig[i]) * (1 - 0.70 * s) + (l1[i] - bMid[i]);
    const bHuge = gauss(l2, w, h, 80 * f);
    const mSoft2 = gauss(Float32Array.from(mask, (v) => v), w, h, 2.5 * f);
    for (let i = 0; i < n; i++) {
      const l3 = bHuge[i] + (l2[i] - bHuge[i]) * (1 - 0.55 * s);
      const mm = Math.min(1, mSoft2[i]);
      let v = L[i] * (1 - mm) + l3 * mm;
      const tex = L[i] - bFine[i];
      if (tex > 0) v += tex * o.keepTexture;
      L[i] = v;
    }
  }

  /* --- 5. nitidezza (unsharp) --- */
  if (o.sharpen > 0) {
    const blurL = gauss(L, w, h, 1.0 * f);
    for (let i = 0; i < n; i++) L[i] = L[i] * (1 + o.sharpen) - blurL[i] * o.sharpen;
  }

  /* --- 6. applica la luminanza nuova e sistema la saturazione --- */
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const Lold = 0.299 * a[p] + 0.587 * a[p + 1] + 0.114 * a[p + 2];
    const ratio = Lold > 1 ? L[i] / Lold : 1;
    const gain = Math.min(2.2, Math.max(0.35, ratio));
    a[p] = Math.min(255, Math.max(0, a[p] * gain));
    a[p + 1] = Math.min(255, Math.max(0, a[p + 1] * gain));
    a[p + 2] = Math.min(255, Math.max(0, a[p + 2] * gain));
  }
  if (o.saturation !== 1) {
    for (let p = 0; p < a.length; p += 4) {
      const l = 0.299 * a[p] + 0.587 * a[p + 1] + 0.114 * a[p + 2];
      a[p] = Math.min(255, Math.max(0, l + (a[p] - l) * o.saturation));
      a[p + 1] = Math.min(255, Math.max(0, l + (a[p + 1] - l) * o.saturation));
      a[p + 2] = Math.min(255, Math.max(0, l + (a[p + 2] - l) * o.saturation));
    }
  }

  return { data: a, width: w, height: h };
}

/* ------------------------------------------------------------------ ridimensionamento */
/** Ridimensiona RGBA con bilinear (usato per il prodotto sul canvas e per lo sfondo). */
export function resizeRGBA(rgba, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  const xr = w / nw, yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, (y + 0.5) * yr - 0.5);
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, (x + 0.5) * xr - 0.5);
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const o = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = rgba[(y0 * w + x0) * 4 + c], p01 = rgba[(y0 * w + x1) * 4 + c];
        const p10 = rgba[(y1 * w + x0) * 4 + c], p11 = rgba[(y1 * w + x1) * 4 + c];
        out[o + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return { data: out, width: nw, height: nh };
}

/** Ritaglio del prodotto e posizionamento su una tela quadrata con margine. */
export function fitProduct(rgba, w, h, canvas, marginPct) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pw = x1 - x0 + 1, ph = y1 - y0 + 1;
  const inner = Math.round(canvas * (1 - 2 * marginPct));
  const scale = Math.min(inner / pw, inner / ph);
  const nw = Math.max(1, Math.round(pw * scale)), nh = Math.max(1, Math.round(ph * scale));

  const crop = new Uint8ClampedArray(pw * ph * 4);
  for (let y = 0; y < ph; y++) {
    const src = ((y + y0) * w + x0) * 4;
    crop.set(rgba.subarray(src, src + pw * 4), y * pw * 4);
  }
  const small = resizeRGBA(crop, pw, ph, nw, nh);

  const out = new Uint8ClampedArray(canvas * canvas * 4);
  const ox = Math.floor((canvas - nw) / 2), oy = Math.floor((canvas - nh) / 2);
  for (let y = 0; y < nh; y++) {
    out.set(small.data.subarray(y * nw * 4, (y + 1) * nw * 4), ((y + oy) * canvas + ox) * 4);
  }
  return { data: out, width: canvas, height: canvas, box: { ox, oy, nw, nh } };
}

/* ------------------------------------------------------------------ composizione */
/** Ombra di contatto morbida sotto il prodotto. */
function contactShadow(product, canvas) {
  const w = canvas, h = canvas;
  const alpha = new Float32Array(w * h);
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = product[p] > 20 ? 1 : 0;

  let maxY = -1;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) if (alpha[y * w + x]) { maxY = y; break; }
    if (maxY >= 0) break;
  }
  if (maxY < 0) return null;

  const band = Math.max(8, Math.round(h / 45));
  const foot = new Float32Array(w * h);
  for (let y = Math.max(0, maxY - band); y <= maxY; y++) {
    for (let x = 0; x < w; x++) if (alpha[y * w + x]) foot[y * w + x] = 1;
  }
  const spread = gauss(foot, w, h, Math.max(6, w / 55));   // equivale al dilata + sfocatura
  const soft = gauss(spread, w, h, Math.max(6, w / 80));
  const shift = Math.max(3, Math.round(h / 110));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - shift;
    if (sy < 0) continue;
    for (let x = 0; x < w; x++) out[y * w + x] = Math.min(105, soft[sy * w + x] * 255 * 0.45);
  }
  return out;
}

export function compose(product, canvas, original, opts = {}) {
  const o = Object.assign({ bgStyle: 'white', contactShadow: true, originalDim: 0.80, originalBlur: 18 }, opts);
  const out = new Uint8ClampedArray(canvas * canvas * 4);

  if (o.bgStyle === 'original' && original) {
    // copre la tela con la foto originale + sfocatura forte + leggera schiarita
    const src = resizeCover(original.data, original.width, original.height, canvas);
    const rgb = new Float32Array(canvas * canvas * 3);
    for (let i = 0, p = 0, q = 0; i < canvas * canvas; i++, p += 4, q += 3) {
      rgb[q] = src[p]; rgb[q + 1] = src[p + 1]; rgb[q + 2] = src[p + 2];
    }
    for (let c = 0; c < 3; c++) {
      const plane = new Float32Array(canvas * canvas);
      for (let i = 0; i < plane.length; i++) plane[i] = rgb[i * 3 + c];
      const blurred = gauss(plane, canvas, canvas, o.originalBlur);
      for (let i = 0; i < plane.length; i++) rgb[i * 3 + c] = blurred[i];
    }
    for (let i = 0, p = 0, q = 0; i < canvas * canvas; i++, p += 4, q += 3) {
      out[p] = rgb[q] * o.originalDim + 255 * (1 - o.originalDim) * 0.9;
      out[p + 1] = rgb[q + 1] * o.originalDim + 255 * (1 - o.originalDim) * 0.9;
      out[p + 2] = rgb[q + 2] * o.originalDim + 255 * (1 - o.originalDim) * 0.9;
      out[p + 3] = 255;
    }
  } else {
    // studio: bianco con gradiente appena percettibile
    for (let y = 0; y < canvas; y++) {
      const base = 255 - (y / canvas) * 8;
      for (let x = 0; x < canvas; x++) {
        const p = (y * canvas + x) * 4;
        const v = Math.min(255, Math.max(0, base + (x / canvas - 0.5) * 4));
        out[p] = v; out[p + 1] = v; out[p + 2] = v; out[p + 3] = 255;
      }
    }
  }

  if (o.contactShadow) {
    const sh = contactShadow(product, canvas);
    if (sh) {
      for (let i = 0, p = 0; i < sh.length; i++, p += 4) {
        const al = sh[i] / 255;
        if (al <= 0) continue;
        out[p] = out[p] * (1 - al) + 30 * al;
        out[p + 1] = out[p + 1] * (1 - al) + 30 * al;
        out[p + 2] = out[p + 2] * (1 - al) + 33 * al;
      }
    }
  }

  // prodotto sopra (alpha compositing)
  for (let p = 0; p < out.length; p += 4) {
    const al = product[p + 3] / 255;
    if (al <= 0) continue;
    out[p] = product[p] * al + out[p] * (1 - al);
    out[p + 1] = product[p + 1] * al + out[p + 1] * (1 - al);
    out[p + 2] = product[p + 2] * al + out[p + 2] * (1 - al);
    out[p + 3] = 255;
  }
  return { data: out, width: canvas, height: canvas };
}

/** Ridimensiona coprendo tutta la tela (cover) centrata. */
function resizeCover(rgba, w, h, canvas) {
  const scale = Math.max(canvas / w, canvas / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const resized = resizeRGBA(rgba, w, h, nw, nh);
  const ox = Math.floor((nw - canvas) / 2), oy = Math.floor((nh - canvas) / 2);
  const out = new Uint8ClampedArray(canvas * canvas * 4);
  for (let y = 0; y < canvas; y++) {
    const src = ((y + oy) * nw + ox) * 4;
    out.set(resized.data.subarray(src, src + canvas * 4), y * canvas * 4);
  }
  return out;
}

/* ------------------------------------------------------------------ orchestrazione */
export function processAll(cutout, original, opts = {}) {
  const o = Object.assign({
    canvas: 1600, mode: 'full', folds: 0.65, product: 'clothing', maxWork: 1400,
  }, opts);
  const steps = [];

  let cut = { data: new Uint8ClampedArray(cutout.data), width: cutout.width, height: cutout.height };

  // risoluzione di lavoro: i sigma sono tarati su 1400 px di lato massimo
  const maxSide = Math.max(cut.width, cut.height);
  const scale = maxSide > o.maxWork ? 1 / (maxSide / o.maxWork) : 1;
  const wr = Math.round(cut.width * scale), hr = Math.round(cut.height * scale);
  if (scale < 0.999) cut = resizeRGBA(cut.data, cut.width, cut.height, wr, hr);

  const sigmaScale = Math.max(cut.width, cut.height) / 1400;

  let folds = o.folds;
  const margin = o.product === 'object' ? 0.055 : 0.09;
  if (o.product === 'object') { folds *= 0.45; steps.push('adattamento per oggetti'); }

  const enh = enhance(cut.data, cut.width, cut.height, {
    smoothFolds: o.mode === 'light' ? folds * 0.5 : folds,
    flattenLighting: o.mode === 'light' ? 0.55 : 0.9,
    sharpen: o.mode === 'light' ? 0.20 : 0.30,
    scale: sigmaScale,
  });
  steps.unshift('rimozione sfondo (nel browser)');
  steps.push('bilanciamento del bianco', 'luci e ombre', 'luce uniforme',
             'distensione pieghe', 'nitidezza', 'ombra e sfondo studio');

  const fitted = fitProduct(enh.data, enh.width, enh.height, o.canvas, margin);
  if (!fitted) throw new Error('Nessun prodotto riconosciuto nella foto.');

  // la foto originale per lo sfondo sfocato va alla risoluzione della tela
  const origCanvas = resizeRGBA(original.data, original.width, original.height,
                                Math.min(o.canvas, 900), Math.round(Math.min(o.canvas, 900) * original.height / original.width));

  const white = compose(fitted.data, o.canvas, null, { bgStyle: 'white', contactShadow: true });
  const origBg = compose(fitted.data, o.canvas, origCanvas, { bgStyle: 'original', contactShadow: true });

  return { white, originalBg: origBg, steps, width: o.canvas, height: o.canvas };
}
