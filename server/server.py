#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vintify/server.py — Vintify: da foto amatoriale a foto professionale da annuncio.

Avvio:  python3 server.py   (poi apri http://localhost:8000)
Il server fa tutto in locale: la foto non lascia la macchina.
"""

from __future__ import annotations

import base64
import io
import os
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import pipeline

ROOT = Path(__file__).parent
OUT = ROOT / "out"
OUT.mkdir(exist_ok=True)
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)

MAX_MB = 12
ALLOWED = {"image/jpeg", "image/png", "image/webp", "image/bmp"}

app = FastAPI(title="Vintify", docs_url="/api/docs", redoc_url=None)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)
app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")
app.mount("/out", StaticFiles(directory=OUT), name="out")

JOBS: dict[str, dict] = {}


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((ROOT / "static" / "index.html").read_text(encoding="utf-8"))


def _warmup() -> None:
    """Precarica il modello di segmentazione così la prima foto è subito veloce."""
    try:
        pipeline._session()
    except Exception as e:  # noqa: BLE001
        print(f"[warmup] modello non precaricato: {e}")


@app.on_event("startup")
def _startup() -> None:
    import threading

    threading.Thread(target=_warmup, daemon=True).start()


@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True, "model_loaded": pipeline.SESSION is not None})


@app.post("/api/process")
async def process(
    file: UploadFile = File(...),
    mode: str = Form("full"),          # full | light
    folds: float = Form(0.65),         # 0..1
    product: str = Form("clothing"),   # clothing | object
) -> JSONResponse:
    if file.content_type not in ALLOWED:
        raise HTTPException(415, f"Formato non supportato ({file.content_type}). Usa JPG, PNG o WebP.")
    data = await file.read()
    if len(data) > MAX_MB * 1024 * 1024:
        raise HTTPException(413, f"File troppo grande (max {MAX_MB} MB).")
    if len(data) < 200:
        raise HTTPException(400, "File vuoto o corrotto.")

    try:
        res = pipeline.process_photo(data, folds=min(1.0, max(0.0, folds)), mode=mode,
                                     product="object" if product == "object" else "clothing")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Elaborazione fallita: {e}") from e

    job = uuid.uuid4().hex[:12]
    jid = os.path.join(OUT.name, job)
    (OUT / f"{job}_white.jpg").write_bytes(res.white)
    (OUT / f"{job}_orig.jpg").write_bytes(res.original_bg)
    JOBS[job] = {
        "created": time.time(),
        "steps": res.steps,
        "ms": res.ms,
        "size": [res.width, res.height],
    }
    return JSONResponse(
        {
            "job": job,
            "white": f"/out/{job}_white.jpg",
            "original": f"/out/{job}_orig.jpg",
            "steps": res.steps,
            "ms": res.ms,
            "size": [res.width, res.height],
        }
    )


@app.get("/api/info/{job}")
def info(job: str) -> JSONResponse:
    if job not in JOBS:
        raise HTTPException(404, "job sconosciuto")
    return JSONResponse(JOBS[job])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
