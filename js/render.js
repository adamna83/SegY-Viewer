/* render.js — variable-density seismic canvas with header strip and time axis. */
(function (root) {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const PALETTES = {
    seismic: [[6, 34, 74], [255, 255, 255], [150, 18, 32]],
    gray: [[0, 0, 0], [255, 255, 255]],
    teal: [[2, 32, 29], [235, 245, 243], [150, 92, 0]],
    fire: [[0, 0, 0], [168, 34, 8], [255, 226, 140]]
  };

  function buildLUT(name) {
    const stops = PALETTES[name] || PALETTES.seismic;
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(t));
      const f = t - k;
      const a = stops[k], b = stops[k + 1];
      lut[i * 3] = Math.round(a[0] + (b[0] - a[0]) * f);
      lut[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
      lut[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    }
    return lut;
  }

  function computeStats(data) {
    const n = data.length;
    const stride = Math.max(1, Math.floor(n / 400000));
    let max = 0, sum2 = 0, cnt = 0, nz = 0;
    for (let i = 0; i < n; i += stride) {
      const v = data[i], a = v < 0 ? -v : v;
      if (a > max) max = a;
      sum2 += v * v; cnt++;
      if (a > 0) nz++;
    }
    const B = 1024;
    const hist = new Uint32Array(B);
    if (max > 0) {
      for (let i = 0; i < n; i += stride) {
        const a = Math.abs(data[i]);
        if (a > 0) hist[Math.min(B - 1, (a / max * B) | 0)]++;
      }
    }
    return { max, rms: cnt ? Math.sqrt(sum2 / cnt) : 0, hist, cnt: cnt || 1, nz: nz || 1 };
  }

  function pct(stats, p) {
    if (!stats.max) return 1;
    let acc = 0;
    const target = stats.nz * p;
    for (let b = 0; b < stats.hist.length; b++) {
      acc += stats.hist[b];
      if (acc >= target) return (b + 1) / stats.hist.length * stats.max;
    }
    return stats.max;
  }

  function niceStep(span, target) {
    const raw = span / target;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    const s = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    return s * p;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  class Viewer {
    constructor(seis, hdr, axis) {
      this.seis = seis; this.hdr = hdr; this.axis = axis;
      this.ctx = seis.getContext('2d');
      this.hctx = hdr.getContext('2d');
      this.actx = axis.getContext('2d');
      this.ds = null; this.data = null;
      this.view = { t0: 0, t1: 1, s0: 0, s1: 1 };
      this.opt = {
        gain: 'clip', clipPct: 99, agcWin: 100, tgain: 1, cmap: 'seismic',
        wiggle: false, header: 'sp', grid: true
      };
      this.cursor = null; this.box = null;
      this.stats = null; this.lut = buildLUT('seismic');
      this._img = null; this._col = null; this._prefix = null; this._fac = null;
      this._hdrVals = null;
      this.dpr = 1;
      this.resize();
    }

    resize() {
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      this.dpr = dpr;
      for (const c of [this.seis, this.hdr, this.axis]) {
        const r = c.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width * dpr));
        const h = Math.max(1, Math.round(r.height * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      }
      this._img = null;
      this.draw();
    }

    setDataset(ds, data) {
      this.ds = ds;
      this.setData(data);
      if (!ds) {
        this.view = { t0: 0, t1: 1, s0: 0, s1: 1 };
        this.cursor = null; this.box = null;
        this.draw();
        return;
      }
      this.view = { t0: 0, t1: Math.max(1, ds.traceCount), s0: 0, s1: Math.max(2, ds.maxNs) };
      this.cursor = null; this.box = null;
      this.draw();
    }

    setData(data) {
      this.data = data;
      this.stats = data && data.length ? computeStats(data) : null;
      this._hdrVals = null;
      if (this.ds || !data) this.draw();
    }

    clipValue() {
      const s = this.stats;
      if (!s) return 1;
      const c = pct(s, this.opt.clipPct / 100);
      return Math.max(c, s.max * 1e-6, 1e-20);
    }

    img(w, h) {
      if (!this._img || this._img.width !== w || this._img.height !== h) {
        this._img = this.ctx.createImageData(w, h);
        const d = this._img.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
      }
      return this._img;
    }

    col(h) {
      if (!this._col || this._col.length !== h) this._col = new Float32Array(h);
      return this._col;
    }

    draw() {
      const ds = this.ds, c = this.ctx;
      const w = this.seis.width, h = this.seis.height;
      if (!w || !h) return;
      if (!ds || !this.data) {
        c.fillStyle = '#0c1a17';
        c.fillRect(0, 0, w, h);
        this.clearSide(w);
        return;
      }
      this.lut = buildLUT(this.opt.cmap);
      const v = this.view, lut = this.lut, data = this.data, nsArr = ds.nsArr;
      const maxNs = ds.maxNs, nTr = ds.traceCount;
      const st = (v.t1 - v.t0) / w, ss = (v.s1 - v.s0) / h;
      const clip = this.clipValue(), scale = 1 / clip;
      const dtMs = ds.dt / 1000;
      const gain = this.opt.gain;
      const agcRows = Math.max(2, Math.round(this.opt.agcWin / dtMs));
      const img = this.img(w, h), d = img.data;
      const col = this.col(h);

      // time-gain factors (row space)
      let fac = null;
      if (gain === 'tgain') {
        if (!this._fac || this._fac.length !== h) this._fac = new Float32Array(h);
        fac = this._fac;
        for (let y = 0; y < h; y++) {
          const t = (v.s0 + (y + 0.5) * ss) * dtMs;
          fac[y] = Math.pow(Math.max(t, dtMs) / 1000, this.opt.tgain);
        }
      }
      // agc prefix buffer
      let pre = null;
      if (gain === 'agc') {
        if (!this._prefix || this._prefix.length !== h + 1) this._prefix = new Float64Array(h + 1);
        pre = this._prefix;
      }
      const target = this.stats ? this.stats.rms : 1;

      for (let x = 0; x < w; x++) {
        const tc = v.t0 + (x + 0.5) * st;
        let ta, tb, stride;
        if (st <= 1.2) {
          ta = clamp(Math.round(tc), 0, nTr - 1); tb = ta + 1; stride = 1;
        } else {
          ta = clamp(Math.floor(tc - st * 0.5), 0, nTr - 1);
          tb = clamp(Math.ceil(tc + st * 0.5) + 1, 1, nTr);
          if (tb <= ta) tb = ta + 1;
          stride = Math.max(1, Math.ceil((tb - ta) / 4));
        }
        if (!isFinite(ta)) continue;
        for (let y = 0; y < h; y++) {
          const sc = v.s0 + (y + 0.5) * ss;
          let i0 = Math.floor(sc), f = sc - i0;
          if (i0 < 0) { i0 = 0; f = 0; }
          if (i0 >= maxNs - 1) { i0 = maxNs - 2; f = 1; }
          let sum = 0, n = 0;
          for (let t = ta; t < tb; t += stride) {
            const ns = nsArr[t] || maxNs, b = t * maxNs;
            const a = i0 < ns ? data[b + i0] : 0;
            const bb = i0 + 1 < ns ? data[b + i0 + 1] : a;
            sum += a + (bb - a) * f; n++;
          }
          col[y] = n ? sum / n : 0;
        }

        if (gain === 'agc') {
          pre[0] = 0;
          for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + col[y] * col[y];
          const half = agcRows >> 1;
          for (let y = 0; y < h; y++) {
            const a = Math.max(0, y - half), b = Math.min(h, y + half + 1);
            const rms = Math.sqrt((pre[b] - pre[a]) / (b - a)) || 1e-12;
            const g = Math.min(300, target / rms);
            let val = col[y] * g * scale;
            if (val > 1) val = 1; else if (val < -1) val = -1;
            const idx = ((val * 0.5 + 0.5) * 255 + 0.5) | 0;
            const o = (y * w + x) * 4, li = idx * 3;
            d[o] = lut[li]; d[o + 1] = lut[li + 1]; d[o + 2] = lut[li + 2];
          }
        } else if (gain === 'tgain') {
          for (let y = 0; y < h; y++) {
            let val = col[y] * fac[y] * scale;
            if (val > 1) val = 1; else if (val < -1) val = -1;
            const idx = ((val * 0.5 + 0.5) * 255 + 0.5) | 0;
            const o = (y * w + x) * 4, li = idx * 3;
            d[o] = lut[li]; d[o + 1] = lut[li + 1]; d[o + 2] = lut[li + 2];
          }
        } else {
          for (let y = 0; y < h; y++) {
            let val = col[y] * scale;
            if (val > 1) val = 1; else if (val < -1) val = -1;
            const idx = ((val * 0.5 + 0.5) * 255 + 0.5) | 0;
            const o = (y * w + x) * 4, li = idx * 3;
            d[o] = lut[li]; d[o + 1] = lut[li + 1]; d[o + 2] = lut[li + 2];
          }
        }
      }
      c.putImageData(img, 0, 0);
      if (this.opt.grid) this.drawGrid();
      if (this.opt.wiggle) this.drawWiggle();
      if (this.box) this.drawBox();
      if (this.cursor) this.drawCursor();
      this.drawHeader();
      this.drawAxis();
    }

    drawGrid() {
      const c = this.ctx, w = this.seis.width, h = this.seis.height;
      const v = this.view, dtMs = this.ds.dt / 1000, dpr = this.dpr;
      const span = (v.s1 - v.s0) * dtMs;
      const step = niceStep(span, 6);
      const t0 = Math.ceil(v.s0 * dtMs / step) * step;
      c.save();
      c.strokeStyle = 'rgba(255,255,255,0.10)';
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.font = `${Math.round(11 * dpr)}px Inter, sans-serif`;
      c.textBaseline = 'bottom';
      for (let t = t0; t <= v.s1 * dtMs; t += step) {
        const y = ((t / dtMs - v.s0) / (v.s1 - v.s0)) * h;
        if (y < 0 || y > h) continue;
        c.beginPath(); c.moveTo(0, Math.round(y) + 0.5); c.lineTo(w, Math.round(y) + 0.5); c.stroke();
        const label = (Math.abs(t) < 1e-9 ? 0 : t).toFixed(step < 1 ? 2 : step < 10 ? 1 : 0) + ' ms';
        const tw = c.measureText(label).width;
        c.fillRect(4, y - 14 * dpr, tw + 8, 14 * dpr);
        c.fillStyle = 'rgba(235,245,243,0.9)';
        c.fillText(label, 8, y - 2);
        c.fillStyle = 'rgba(0,0,0,0.55)';
      }
      c.restore();
    }

    drawWiggle() {
      const ds = this.ds, c = this.ctx, w = this.seis.width, h = this.seis.height;
      const v = this.view, span = v.t1 - v.t0;
      const pxPerTrace = w / span;
      if (pxPerTrace < 5) return;
      const clip = this.clipValue(), data = this.data, maxNs = ds.maxNs, nsArr = ds.nsArr;
      const ss = (v.s1 - v.s0) / h;
      const stepPx = Math.max(1, Math.round(1.5 * this.dpr));
      c.save();
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = Math.max(1, this.dpr * 0.6);
      const t0 = Math.max(0, Math.floor(v.t0)), t1 = Math.min(ds.traceCount, Math.ceil(v.t1));
      const amp = pxPerTrace * 0.38;
      for (let t = t0; t < t1; t++) {
        const x = ((t - v.t0) / span) * w;
        const ns = nsArr[t] || maxNs, b = t * maxNs;
        c.beginPath();
        let started = false;
        for (let y = 0; y <= h; y += stepPx) {
          const sc = v.s0 + (y + 0.5) * ss;
          let i0 = Math.round(sc);
          if (i0 < 0) i0 = 0; if (i0 >= ns) i0 = ns - 1;
          let val = data[b + i0] / clip;
          if (val > 1) val = 1; else if (val < -1) val = -1;
          const px = x + val * amp;
          if (!started) { c.moveTo(px, y); started = true; } else c.lineTo(px, y);
        }
        c.stroke();
      }
      c.restore();
    }

    drawBox() {
      const c = this.ctx, b = this.box;
      c.save();
      c.strokeStyle = '#00a19c';
      c.fillStyle = 'rgba(0,161,156,0.12)';
      c.lineWidth = this.dpr;
      const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
      const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
      c.fillRect(x, y, w, h);
      c.strokeRect(x, y, w, h);
      c.restore();
    }

    drawCursor() {
      const c = this.ctx, w = this.seis.width, h = this.seis.height, cu = this.cursor;
      const v = this.view;
      const x = ((cu.trace - v.t0) / (v.t1 - v.t0)) * w;
      const y = ((cu.sample - v.s0) / (v.s1 - v.s0)) * h;
      c.save();
      c.strokeStyle = 'rgba(0,161,156,0.9)';
      c.lineWidth = this.dpr;
      c.beginPath();
      c.moveTo(x, 0); c.lineTo(x, h);
      c.moveTo(0, y); c.lineTo(w, y);
      c.stroke();
      c.restore();
    }

    drawHeader() {
      const hc = this.hctx, w = this.hdr.width, h = this.hdr.height;
      hc.clearRect(0, 0, w, h);
      hc.fillStyle = '#0c1a17';
      hc.fillRect(0, 0, w, h);
      const ds = this.ds;
      if (!ds) return;
      const key = this.opt.header;
      const f = ds.fields[key];
      const v = this.view, n = ds.traceCount;
      const t0 = Math.max(0, Math.floor(v.t0)), t1 = Math.min(n, Math.ceil(v.t1) + 1);
      hc.strokeStyle = 'rgba(0,161,156,0.9)';
      hc.lineWidth = Math.max(1, this.dpr);
      hc.beginPath();
      let min = Infinity, max = -Infinity, any = false;
      const span = v.t1 - v.t0;
      const tmp = [];
      for (let t = t0; t < t1; t++) {
        const val = f ? f[t] : 0;
        if (!isFinite(val)) continue;
        any = true;
        if (val < min) min = val; if (val > max) max = val;
        const x = ((t - v.t0) / span) * w;
        tmp.push([x, val]);
      }
      if (any && max > min) {
        for (let i = 0; i < tmp.length; i++) {
          const x = tmp[i][0];
          const y = h - 8 - ((tmp[i][1] - min) / (max - min)) * (h - 16);
          if (i === 0) hc.moveTo(x, y); else hc.lineTo(x, y);
        }
        hc.stroke();
        hc.fillStyle = 'rgba(235,245,243,0.85)';
        hc.font = `${Math.round(10 * this.dpr)}px Inter, sans-serif`;
        const label = (this.headerLabel() + '  ' + fmtNum(min) + ' – ' + fmtNum(max));
        hc.fillText(label, 8, 13 * this.dpr);
      } else {
        hc.fillStyle = 'rgba(235,245,243,0.6)';
        hc.font = `${Math.round(10 * this.dpr)}px Inter, sans-serif`;
        hc.fillText('No usable header curve for this field', 8, 13 * this.dpr);
      }
      if (this.cursor) {
        const x = ((this.cursor.trace - v.t0) / (v.t1 - v.t0)) * w;
        hc.strokeStyle = 'rgba(0,161,156,0.7)';
        hc.beginPath(); hc.moveTo(x, 0); hc.lineTo(x, h); hc.stroke();
      }
    }

    headerLabel() {
      if (this.opt.header === 'dist') return 'Distance along line';
      const def = (root.SEGY && SEGY.FIELD_DEFS || []).find(f => f.key === this.opt.header);
      return def ? def.name : this.opt.header;
    }

    drawAxis() {
      const c = this.actx, w = this.axis.width, h = this.axis.height;
      c.fillStyle = '#0c1a17';
      c.fillRect(0, 0, w, h);
      if (!this.ds) return;
      const dtMs = this.ds.dt / 1000;
      const v = this.view;
      const span = (v.s1 - v.s0) * dtMs;
      const step = niceStep(span, 8);
      const start = Math.ceil(v.s0 * dtMs / step) * step;
      c.fillStyle = 'rgba(235,245,243,0.75)';
      c.font = `${Math.round(10 * this.dpr)}px Inter, sans-serif`;
      c.textBaseline = 'middle';
      c.textAlign = 'center';
      for (let t = start; t <= v.s1 * dtMs; t += step) {
        const x = ((t / dtMs - v.s0) / (v.s1 - v.s0)) * w;
        if (x < 20 || x > w - 20) continue;
        c.fillText(t.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0), x, h / 2);
        c.fillStyle = 'rgba(255,255,255,0.2)';
        c.fillRect(x, 0, 1, 4);
        c.fillStyle = 'rgba(235,245,243,0.75)';
      }
      c.textAlign = 'left';
      c.fillStyle = 'rgba(235,245,243,0.45)';
      c.fillText('ms', 6, h / 2);
    }

    clearSide(w) {
      for (const [ctx, canv] of [[this.hctx, this.hdr], [this.actx, this.axis]]) {
        ctx.fillStyle = '#0c1a17';
        ctx.fillRect(0, 0, canv.width, canv.height);
      }
      void w;
    }

    // ---- interaction helpers
    pxToData(px, py) {
      const v = this.view, w = this.seis.width, h = this.seis.height;
      return {
        trace: v.t0 + clamp(px / w, 0, 1) * (v.t1 - v.t0),
        sample: clamp(v.s0 + clamp(py / h, 0, 1) * (v.s1 - v.s0), 0, this.ds.maxNs - 1)
      };
    }

    zoom(factor, fx, fy, axis) {
      const v = this.view;
      if (!this.ds) return;
      if (axis === 'trace' || axis === 'x') {
        const anchor = v.t0 + fx * (v.t1 - v.t0);
        let span = (v.t1 - v.t0) / factor;
        span = clamp(span, Math.min(2, this.ds.traceCount), this.ds.traceCount);
        let a = anchor - fx * span, b = a + span;
        if (a < 0) { a = 0; b = span; }
        if (b > this.ds.traceCount) { b = this.ds.traceCount; a = b - span; }
        v.t0 = a; v.t1 = b;
      } else {
        const anchor = v.s0 + fy * (v.s1 - v.s0);
        let span = (v.s1 - v.s0) / factor;
        span = clamp(span, Math.min(4, this.ds.maxNs), this.ds.maxNs);
        let a = anchor - fy * span, b = a + span;
        if (a < 0) { a = 0; b = span; }
        if (b > this.ds.maxNs) { b = this.ds.maxNs; a = b - span; }
        v.s0 = a; v.s1 = b;
      }
      this.draw();
    }

    pan(dxPx, dyPx) {
      if (!this.ds) return;
      const v = this.view;
      const dT = -dxPx / this.seis.width * (v.t1 - v.t0);
      const dS = -dyPx / this.seis.height * (v.s1 - v.s0);
      let a = v.t0 + dT, b = v.t1 + dT;
      if (a < 0) { b -= a; a = 0; }
      if (b > this.ds.traceCount) { b = this.ds.traceCount; a = b - (v.t1 - v.t0); }
      v.t0 = a; v.t1 = b;
      let s0 = v.s0 + dS, s1 = v.s1 + dS;
      if (s0 < 0) { s1 -= s0; s0 = 0; }
      if (s1 > this.ds.maxNs) { s1 = this.ds.maxNs; s0 = s1 - (v.s1 - v.s0); }
      v.s0 = Math.max(0, s0); v.s1 = Math.min(this.ds.maxNs, s1);
      this.draw();
    }

    zoomToBox(box) {
      if (!this.ds) return;
      const p0 = this.pxToData(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1));
      const p1 = this.pxToData(Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
      if (p1.trace - p0.trace < 0.5 || p1.sample - p0.sample < 1) return;
      this.view = { t0: p0.trace, t1: p1.trace, s0: p0.sample, s1: p1.sample };
      this.draw();
    }

    resetView() {
      if (!this.ds) return;
      this.view = { t0: 0, t1: Math.max(1, this.ds.traceCount), s0: 0, s1: Math.max(2, this.ds.maxNs) };
      this.draw();
    }

    setCursor(trace, sample) {
      this.cursor = { trace, sample };
      this.draw();
    }
  }

  function fmtNum(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
    if (a >= 100) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(3);
  }

  root.Viewer = Viewer;
  root.ViewerUtil = { computeStats, pct, buildLUT, niceStep, fmtNum, clamp, cssVar };
})(window);
