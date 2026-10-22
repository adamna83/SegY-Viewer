# SEG-Y Studio

Browser-based SEG-Y viewer and light trace-conditioning tool for marine site
survey QC. Runs entirely client-side: files never leave the machine.

Styled to the myPETRONAS palette (teal `#00a19c`, self-hosted Inter).

## Quick start

**Option A — local server (recommended, enables Browse drive)**

Double-click `start.bat`, or:

```
python serve.py
```

Then open http://127.0.0.1:8765/ (opened automatically).

`serve.py` is stdlib-only and exposes the survey archive read-only through:

- `GET /api/list?path=...` — folders + `.sgy`/`.segy` files
- `GET /api/file?path=...` — file bytes, HTTP Range supported

Default browse root: `Z:\06.GHO\06.Report Registration\2026\Site Survey`
(override with `python serve.py --root "D:\survey"`). The server binds to
`127.0.0.1` only.

**Option B — no server**

Open `index.html` directly. Open files / Open folder and drag-and-drop work;
"Browse drive" is hidden because browsers cannot read `file://` siblings.

## Viewing

| Action | Result |
|---|---|
| Wheel | Zoom time axis at cursor |
| Ctrl / Alt + wheel | Zoom trace axis at cursor |
| Drag | Pan |
| Shift + drag | Box zoom |
| Double-click | Fit section |
| Click | Place cursor, fill Trace inspector |
| `+` / `-` | Zoom time |
| `f` | Fit |
| `w` | Toggle wiggle overlay |
| `o` / `p` | Original / Processed |

Display gain: **Clip** (percentile of non-zero samples), **AGC** (per-column
running RMS), **T^n**. Palettes: blue/white/red, greyscale, deep teal/gold,
black/ember. The header strip plots any selected trace header (shot point, CDP,
offset, distance, water depth, coordinates …).

## Processing chain

Steps run in order on a copy of the data; the original is always kept for A/B.

- Band-pass (zero-phase Butterworth)
- Ormsby
- Notch
- Spectral deconvolution (Wiener, noise/smoothing/strength)
- Spectral whitening
- AGC
- T^n gain
- Static shift
- Top/bottom mute with taper
- Normalize (RMS/max)
- Median filter
- Trace mix
- Hilbert envelope
- Scale

Presets are chosen from sample rate on load: **Sparker** (≤120 µs) and
**2DHR** (>120 µs). Chains are per file; Apply is asynchronous with progress
and cancel, and the UI stays responsive.

Exports: **SEG-Y** (original headers + updated C11, formats 1/2/3/5),
**PNG** of the current section, **headers CSV**.

## SEG-Y support

- Auto-detects big/little endian and EBCDIC/ASCII text headers.
- Reads sample formats 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16.
- Handles extended text headers and variable trace lengths.
- Coordinate/elevation scalars applied per SEG-Y convention; distance along
  line computed from coordinates when they look usable.
- Writes formats 1 (IBM float), 2, 3 and 5.

Verified against:

- `BAJT-18` sparker, single channel, 51 µs, 4864 samples, IEEE float, EBCDIC
- `CAIMAN-2` 2DHR migrated stack, 500 µs, 3903 samples, IBM float, 691 CDPs

## Limitations

- Whole file is held in memory as Float32 (≈4 bytes/sample); a 40 MB file is
  ≈42 MB in RAM, plus the processed copy.
- 2D only (no 3D cube / inline-crossline browsing).
- Write-back only changes sample values, C11, ns/dt/format; trace-header edits
  are not supported.
- Deconvolution is frequency-domain (Wiener) rather than a time-domain
  predictive operator.
- Very large chains on 2,000+ trace sparker files take several seconds each
  (progress is shown).

## Files

```
index.html        UI
app.css           layout (brand tokens from brand.css)
brand.css         myPETRONAS brand layer
fonts/            self-hosted Inter woff2
js/segy.js        SEG-Y parser + writer
js/dsp.js         FFT, filters, gains, decon, envelope
js/render.js      variable-density canvas renderer
js/app.js         UI wiring, chain, exports, drive browser
serve.py          local static + drive-browse server
start.bat         launcher
```
