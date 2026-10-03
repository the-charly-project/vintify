# Vintify

**Da foto amatoriale a foto da annuncio.** Carichi la foto del prodotto stropicciato e ricevi
una foto da catalogo: sfondo **bianco studio** oppure **originale sfocato**, con luci e colori
sistemati, pieghe attenuate e trama del tessuto preservata.

### 🔗 Sito live: **https://the-charly-project.github.io/vintify/**

Nessuna registrazione, nessun watermark, nessun limite di foto.

---

## Come funziona

Tutto gira **nel browser di chi usa il sito** (AI in WebAssembly + Web Worker): le foto
**non vengono inviate a nessun server**, non serve una VPS e non c'è alcun costo di hosting.

Pipeline: segmentazione del prodotto (u2net) → bilanciamento del bianco (lo sfondo come riferimento
dell'illuminante) → luci/ombre → luce uniforme → distensione pieghe sulla banda di frequenza
giusta, con trama del tessuto reinserita → nitidezza → composizione con ombra di contatto.

## Contenuto del repository

| Percorso | Cosa |
|---|---|
| `index.html`, `worker.js`, `pipeline.js` | il sito (versione 100% browser) — è questa che viene pubblicata su GitHub Pages |
| `vendor/imgly-loader.mjs` | loader di `@imgly/background-removal` salvato in locale |
| `sw.js` | service worker: dopo la prima visita il sito funziona anche offline |
| `assets/` | immagini di esempio (prima/dopo) |
| `server/` | versione alternativa con backend Python (FastAPI + rembg), per chi ha una VPS |

## Uso in locale

```bash
python3 -m http.server 8001   # poi apri http://localhost:8001
```

## Versione con server (opzionale)

```bash
cd server
pip install fastapi "uvicorn[standard]" python-multipart rembg onnxruntime pillow numpy opencv-python
python3 server.py             # -> http://localhost:8000  (API: /api/docs)
```

## Note

- Il modello AI di segmentazione è `@imgly/background-removal` (**GPL-3.0**): ottimo per progetti
  personali/open source; per un uso commerciale chiuso serve la licenza commerciale di IMG.LY.
  La pipeline accetta comunque qualsiasi ritaglio RGBA, quindi il motore si può sostituire.
- I tempi: prima foto +10–40 s (scarica ~40 MB di modello, poi resta in cache), foto successive 3–8 s.
- Marchio e logo sono **originali**: il progetto evoca l'estetica dei marketplace di usato ma
  **non è affiliato a Vinted** e non ne imita il marchio.
