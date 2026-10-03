# Vintify

Da foto amatoriale a foto professionale da annuncio: carichi la foto del prodotto, ricevi
**sfondo bianco studio** oppure **sfondo originale sfocato**, con luci/colori sistemati,
pieghe attenuate e trama del tessuto preservata.

Tutto in locale: la foto non lascia la macchina che esegue il server. Nessun login, nessun watermark.

## Avvio

```bash
pip install fastapi "uvicorn[standard]" python-multipart rembg onnxruntime pillow numpy opencv-python
cd vintify
python3 server.py          # -> http://localhost:8000
```

La prima esecuzione scarica il modello di segmentazione (~176 MB, una sola volta).
Modello u2net via rembg: licenza Apache-2.0, uso commerciale consentito.

## Com'è fatto

| File | Ruolo |
|---|---|
| `pipeline.py` | segmentazione → ritocco (colore, luci, pieghe, trama) → composizione sfondo |
| `server.py` | API FastAPI: `POST /api/process`, `GET /api/health`, docs su `/api/docs` |
| `static/index.html` | interfaccia: upload, opzioni, confronto prima/dopo, download |

### La pipeline, passo per passo
1. **Segmentazione** — u2net (rembg) isola il prodotto; per foto grandi la segmentazione gira a 2048 px e la maschera viene riportata a piena risoluzione.
2. **Bilanciamento del bianco** — usa lo *sfondo* come riferimento dell'illuminante (es. luce gialla), così i colori del prodotto non vengono desaturati.
3. **Luci e ombre** — stira con delicatezza l'istogramma e solleva le ombre.
4. **Luce uniforme** — corregge le zone d'ombra sul prodotto (es. bordo che cade fuori dalla finestra di luce).
5. **Distensione pieghe** — comprime la banda di frequenze delle pieghe (righe d'ombra incluse) e restituisce la micro-trama del tessuto: risultato "stirato", non "plastificato".
6. **Composizione** — sfondo bianco 2000×2000 con ombra di contatto realistica, oppure sfondo originale sfocato e desaturato.

## API

```bash
curl -X POST http://localhost:8000/api/process \
  -F "file=@foto.jpg" -F "mode=full" -F "folds=0.65" -F "product=clothing"
```

| Campo | Valori | Default | Note |
|---|---|---|---|
| `file` | JPG/PNG/WebP/BMP ≤ 12 MB | — | la rotazione EXIF viene applicata |
| `mode` | `full` \| `light` | `full` | `light` conserva l'aspetto più autentico |
| `folds` | 0–1 | `0.65` | quanto spingere su luci e pieghe |
| `product` | `clothing` \| `object` | `clothing` | `object` = ritaglio più stretto + raddrizzamento automatico |

Risposta: `{job, white, original, steps, ms, size}` con i due URL delle immagini.

## Note

- Tempi misurati su 2 core CPU: **2–6 s per foto**.
- Vintify non inventa dettagli: migliora l'esposizione e distende le pieghe, ma l'usura reale resta
  visibile (è ciò che i marketplace richiedono).
- Marchio e logo sono originali: il nome evoca l'estetica dei marketplace di usato, ma il progetto
  non è affiliato a Vinted e non va usato per imitarne il marchio.
