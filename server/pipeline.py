#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vintify/pipeline.py — Da foto amatoriale a foto da catalogo.

Fasi:
  1. segmentazione del prodotto (u2net / rembg, gira in locale)
  2. ritocco: bilanciamento del bianco, luci/ombre, distensione pieghe, nitidezza
  3. composizione: sfondo bianco studio (con ombra di contatto) o sfondo originale sfocato
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image, ImageFilter, ImageOps

SESSION = None


def _session():
    global SESSION
    if SESSION is None:
        from rembg import new_session

        SESSION = new_session("u2net")
    return SESSION


# ---------------------------------------------------------------- 1. segmentazione
def cutout(img: Image.Image) -> Image.Image:
    """Rimuove lo sfondo, ritorna RGBA. Ridimensiona internamente per la velocità."""
    from rembg import remove

    maxtot = 2048
    big = max(img.size) > maxtot
    work = img
    if big:
        r = maxtot / max(img.size)
        work = img.resize((int(img.width * r), int(img.height * r)), Image.LANCZOS)
    out = remove(work, session=_session())
    if big:
        out = out.resize(img.size, Image.LANCZOS)
    return out


def _deskew(rgba: Image.Image) -> tuple[Image.Image, float]:
    """Raddrizza il prodotto se è inclinato (utile per scarpe e oggetti)."""
    arr = np.array(rgba)
    mask = (arr[:, :, 3] > 127).astype(np.uint8)
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return rgba, 0.0
    c = max(cnts, key=cv2.contourArea)
    (_, _), (w, h), ang = cv2.minAreaRect(c)
    if w < h:
        ang += 90
    ang = ((ang + 90) % 180) - 90          # -> [-90, 90)
    if 6 < abs(ang) < 80:
        return rgba.rotate(-ang, expand=True, resample=Image.BICUBIC), ang
    return rgba, 0.0


# ---------------------------------------------------------------- 2. ritocco
@dataclass
class EnhanceOpts:
    white_balance: bool = True
    lift_shadows: bool = True
    flat_lighting: float = 0.9      # uniforma l'illuminazione sul prodotto (0..1)
    smooth_folds: float = 0.65      # attenuazione pieghe (0..1)
    keep_texture: float = 0.35      # quanto restituire di micro-trama del tessuto
    sharpen: float = 0.30
    saturation: float = 1.05
    warm_cool: float = 0.0          # >0 più caldo, <0 più freddo (-1..1)


def _illuminant_fix(bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Bilanciamento del bianco usando lo sfondo come riferimento dell'illuminante."""
    sat = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[:, :, 1]
    bg = alpha < 40
    ref = bgr[bg & (sat < 60)] if bg.sum() > 500 else np.empty((0, 3), np.uint8)
    if len(ref) < 300:
        prod = alpha > 127
        if not prod.any():
            return bgr
        thr = max(35.0, np.percentile(sat[prod], 35))
        ref = bgr[prod & (sat <= thr)]
    if len(ref) < 100:
        return bgr
    means = ref.reshape(-1, 3).astype(np.float32).mean(axis=0)
    if means.max() < 25:
        return bgr
    gains = np.clip(means.mean() / np.maximum(means, 1e-6), 0.86, 1.16)
    return np.clip(bgr.astype(np.float32) * gains, 0, 255).astype(np.uint8)


def _levels_fill(L: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Stira l'istogramma con delicatezza e solleva le ombre."""
    l = L.astype(np.float32)
    vals = l[mask > 127]
    if len(vals) > 200:
        lo, hi = np.percentile(vals, 2.0), np.percentile(vals, 99.5)
        med = np.median(vals)
        if hi - lo > 40 and med < 165:
            tlo = lo * 0.35
            st = np.clip((l - tlo) * (255.0 / max(60.0, hi - tlo)), 0, 255)
            l = l + (st - l) * 0.5
    l = 255.0 * np.power(np.clip(l, 0, 255) / 255.0, 0.94)
    return np.clip(l, 0, 255)


def _flatten_lighting(L: np.ndarray, mask: np.ndarray, strength: float, radius: float = 110.0) -> np.ndarray:
    """Uniforma l'illuminazione sul prodotto (corregge la zona d'ombra sul bordo)."""
    if strength <= 0:
        return L
    l = L.astype(np.float32)
    illum = cv2.GaussianBlur(l, (0, 0), radius)
    sel = mask > 127
    if sel.sum() < 200:
        return L
    ref = float(np.median(illum[sel]))
    corr = np.clip(ref / np.maximum(illum, 1e-3), 0.80, 1.30)
    corr = 1.0 + (corr - 1.0) * strength
    m = cv2.GaussianBlur(sel.astype(np.float32), (0, 0), 2.5)
    return np.clip(l * (1 - m) + (l * corr) * m, 0, 255)


def _soften_folds(L: np.ndarray, mask: np.ndarray, strength: float, keep_texture: float) -> np.ndarray:
    """Comprime la banda di frequenze delle pieghe (righe d'ombra comprese)."""
    if strength <= 0:
        return L
    s = min(1.0, max(0.0, strength))
    l = L.astype(np.float32)
    b_fine = cv2.GaussianBlur(l, (0, 0), 2.2)
    d = l - b_fine
    d = np.where(d < 0, d * (1.0 - 0.55 * s), d * (1.0 - 0.10 * s))
    l1 = b_fine + d
    b_mid = cv2.GaussianBlur(l1, (0, 0), 7.0)
    b_big = cv2.GaussianBlur(l1, (0, 0), 26.0)
    l2 = b_big + (b_mid - b_big) * (1.0 - 0.70 * s) + (l1 - b_mid)
    b_huge = cv2.GaussianBlur(l2, (0, 0), 80.0)
    l3 = b_huge + (l2 - b_huge) * (1.0 - 0.55 * s)
    m = cv2.GaussianBlur((mask > 127).astype(np.float32), (0, 0), 2.5)
    l4 = l * (1 - m) + l3 * m
    tex = l - b_fine
    l4 = l4 + np.where(tex > 0, tex, 0) * keep_texture
    return np.clip(l4, 0, 255)


def _adjust(bgr: np.ndarray, saturation: float, warm_cool: float) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[:, :, 1] = np.clip(hsv[:, :, 1] * saturation, 0, 255)
    out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    if warm_cool != 0:
        lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB).astype(np.float32)
        lab[:, :, 2] = np.clip(lab[:, :, 2] + warm_cool * 5.0, 0, 255)
        out = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2BGR)
    return out


def enhance(rgba: Image.Image, opts: EnhanceOpts | None = None) -> tuple[Image.Image, list[str]]:
    opts = opts or EnhanceOpts()
    steps: list[str] = []
    arr = np.array(rgba)
    if arr.ndim != 3 or arr.shape[2] < 4:
        return rgba, steps
    bgr = cv2.cvtColor(arr[:, :, :3], cv2.COLOR_RGB2BGR).astype(np.uint8)
    alpha = arr[:, :, 3]
    mask = (alpha > 127).astype(np.uint8) * 255

    out = bgr
    if opts.white_balance:
        out = _illuminant_fix(out, alpha)
        steps.append("bilanciamento del bianco")

    lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)
    if opts.lift_shadows:
        lab[:, :, 0] = _levels_fill(lab[:, :, 0], mask).astype(np.uint8)
        steps.append("luci e ombre")
    if opts.flat_lighting > 0:
        lab[:, :, 0] = _flatten_lighting(lab[:, :, 0], mask, opts.flat_lighting).astype(np.uint8)
        steps.append("luce uniforme")
    if opts.smooth_folds > 0:
        lab[:, :, 0] = _soften_folds(lab[:, :, 0], mask, opts.smooth_folds, opts.keep_texture).astype(np.uint8)
        steps.append("distensione pieghe")
    out = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    if opts.sharpen > 0:
        blur = cv2.GaussianBlur(out, (0, 0), 1.0)
        out = cv2.addWeighted(out, 1 + opts.sharpen, blur, -opts.sharpen, 0)
        steps.append("nitidezza")

    out = _adjust(out, opts.saturation, opts.warm_cool)
    rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA"), steps


# ---------------------------------------------------------------- 3. composizione
@dataclass
class ComposeOpts:
    canvas: int = 2000
    margin_pct: float = 0.09
    contact_shadow: bool = True
    bg_style: str = "white"     # "white" | "original"
    original_dim: float = 0.80
    original_blur: float = 18.0


def _fit_on_canvas(rgba: Image.Image, canvas: int, margin_pct: float) -> Image.Image:
    bbox = rgba.getbbox() or (0, 0, rgba.width, rgba.height)
    prod = rgba.crop(bbox)
    inner = int(canvas * (1 - 2 * margin_pct))
    scale = min(inner / prod.width, inner / prod.height)
    new = (max(1, int(prod.width * scale)), max(1, int(prod.height * scale)))
    prod = prod.resize(new, Image.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(prod, ((canvas - new[0]) // 2, (canvas - new[1]) // 2), prod)
    return out


def _contact_shadow(product: Image.Image) -> Image.Image:
    """Ombra morbida alla base del prodotto: fa sembrare la foto scattata in studio."""
    alpha = np.array(product.split()[3])
    mask = (alpha > 20).astype(np.uint8)
    layer = Image.new("RGBA", product.size, (0, 0, 0, 0))
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return layer
    h, w = mask.shape
    footprint = np.zeros_like(mask, dtype=np.uint8)
    band = max(8, h // 45)
    sel = ys >= (ys.max() - band)
    footprint[ys[sel], xs[sel]] = 255
    k = max(9, int(w / 55) | 1)
    foot = cv2.dilate(footprint, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    foot = (cv2.GaussianBlur(foot, (0, 0), max(6.0, w / 80)) * 0.45).astype(np.float32)
    foot = np.roll(foot, max(3, h // 110), axis=0)
    foot = np.clip(foot, 0, 105).astype(np.uint8)
    layer.paste(Image.new("RGBA", product.size, (30, 30, 33, 255)), (0, 0), Image.fromarray(foot, "L"))
    return layer


def compose(rgba_enhanced: Image.Image, original: Image.Image, opts: ComposeOpts | None = None) -> Image.Image:
    opts = opts or ComposeOpts()
    canvas = opts.canvas
    product = _fit_on_canvas(rgba_enhanced, canvas, opts.margin_pct)

    if opts.bg_style == "original":
        bg = original.convert("RGB")
        r = max(canvas / bg.width, canvas / bg.height)
        bg = bg.resize((max(canvas, int(bg.width * r)), max(canvas, int(bg.height * r))), Image.LANCZOS)
        left, top = (bg.width - canvas) // 2, (bg.height - canvas) // 2
        bg = bg.crop((left, top, left + canvas, top + canvas)).filter(ImageFilter.GaussianBlur(opts.original_blur))
        arr = np.array(bg).astype(np.float32)
        arr = np.clip(arr * opts.original_dim + 255 * (1 - opts.original_dim) * 0.9, 0, 255).astype(np.uint8)
        base = Image.fromarray(arr, "RGB")
    else:
        yy = np.linspace(255, 247, canvas).reshape(-1, 1)
        xx = np.linspace(-2, 2, canvas).reshape(1, -1)
        plane = np.clip(yy + xx, 0, 255).astype(np.uint8)
        base = Image.fromarray(np.dstack([plane] * 3), "RGB")

    base = base.convert("RGBA")
    if opts.contact_shadow:
        base.alpha_composite(_contact_shadow(product))
    base.alpha_composite(product)
    return base.convert("RGB")


# ---------------------------------------------------------------- API
def to_bytes(img: Image.Image, fmt: str = "JPEG", quality: int = 90) -> bytes:
    buf = io.BytesIO()
    if fmt == "JPEG":
        img.save(buf, fmt, quality=quality, subsampling=1, optimize=True)
    else:
        img.save(buf, fmt, optimize=True)
    return buf.getvalue()


@dataclass
class Result:
    white: bytes
    original_bg: bytes
    steps: list[str] = field(default_factory=list)
    ms: int = 0
    width: int = 0
    height: int = 0


def process_photo(data: bytes, canvas: int = 2000, folds: float = 0.65, mode: str = "full",
                   product: str = "clothing") -> Result:
    import time

    t0 = time.time()
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # foto da smartphone ruotate
    img.load()
    img = img.convert("RGB")
    if max(img.size) > 3000:
        r = 3000 / max(img.size)
        img = img.resize((int(img.width * r), int(img.height * r)), Image.LANCZOS)

    cut = cutout(img)

    steps: list[str] = []
    if product == "object":
        cut, ang = _deskew(cut)
        if ang:
            steps.append(f"raddrizzamento ({ang:.0f}°)")
        folds = folds * 0.45          # su scarpe/oggetti le "pieghe" sono usura: meglio non esagerare
        margin = 0.055
    else:
        margin = 0.09

    opts = EnhanceOpts()
    if mode == "light":
        opts = EnhanceOpts(flat_lighting=0.55, smooth_folds=folds * 0.5, sharpen=0.2)
    else:
        opts.smooth_folds = folds
    enh, esteps = enhance(cut, opts)
    steps += esteps

    white = compose(enh, img, ComposeOpts(bg_style="white", canvas=canvas, margin_pct=margin))
    orig = compose(enh, img, ComposeOpts(bg_style="original", canvas=min(canvas, 1600), margin_pct=margin))

    return Result(
        white=to_bytes(white),
        original_bg=to_bytes(orig),
        steps=["rimozione sfondo (AI)"] + steps + ["ombra e sfondo studio"],
        ms=int((time.time() - t0) * 1000),
        width=white.width,
        height=white.height,
    )
