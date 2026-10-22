/* dsp.js — FFT + seismic conditioning. Attaches to window (or global in Node). */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ FFT
  const plans = new Map();
  function plan(n) {
    let p = plans.get(n);
    if (p) return p;
    const rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>>= 1; }
      rev[i] = r;
    }
    const half = n >> 1;
    const cos = new Float64Array(half), sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    p = { n, rev, cos, sin, bits };
    plans.set(n, p);
    return p;
  }

  function fft(re, im, n, inverse) {
    const p = plan(n), rev = p.rev, cos = p.cos, sin = p.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        let k = 0;
        for (let j = 0; j < half; j++, k += step) {
          const c = cos[k], s = inverse ? sin[k] : -sin[k];
          const a = i + j, b = a + half;
          const br = re[b], bi = im[b];
          const tr = br * c - bi * s;
          const ti = br * s + bi * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
    }
  }

  // real FFT: x[0..N-1] -> X[0..N/2] (re/im arrays length N/2+1)
  function rfft(x, N, outRe, outIm) {
    const M = N >> 1;
    const zr = new Float64Array(M), zi = new Float64Array(M);
    for (let k = 0; k < M; k++) { zr[k] = x[2 * k]; zi[k] = x[2 * k + 1]; }
    fft(zr, zi, M, false);
    outRe[0] = zr[0] + zi[0]; outIm[0] = 0;
    outRe[M] = zr[0] - zi[0]; outIm[M] = 0;
    for (let k = 1; k < M; k++) {
      const kr = M - k;
      const ar = 0.5 * (zr[k] + zr[kr]);
      const ai = 0.5 * (zi[k] - zi[kr]);
      const br = 0.5 * (zr[k] - zr[kr]);
      const bi = 0.5 * (zi[k] + zi[kr]);
      const th = 2 * Math.PI * k / N;
      const c = Math.cos(th), s = Math.sin(th);
      outRe[k] = ar + (c * bi - s * br);
      outIm[k] = ai - (s * bi + c * br);
    }
    return { M };
  }

  // inverse real FFT from X[0..N/2]; rebuilds the Hermitian spectrum then
  // runs a full inverse complex FFT (unambiguous, ~1.5x cost of rfft pair).
  function irfft(re, im, N, out, fullRe, fullIm) {
    const M = N >> 1;
    const fr = fullRe || new Float64Array(N);
    const fi = fullIm || new Float64Array(N);
    for (let k = 0; k <= M; k++) { fr[k] = re[k]; fi[k] = im[k]; }
    for (let k = 1; k < M; k++) { fr[N - k] = re[k]; fi[N - k] = -im[k]; }
    fft(fr, fi, N, true);
    for (let i = 0; i < N; i++) out[i] = fr[i];
    return out;
  }

  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // ------------------------------------------------------------ FIR-free filters
  function butterH(f, lo, hi, order) {
    let h = 1;
    if (hi > 0 && hi < 1e9) {
      const r = f / hi;
      h /= Math.sqrt(1 + Math.pow(r, 2 * order));
    }
    if (lo > 0) {
      if (f <= 0) return 0;
      const r = lo / f;
      h /= Math.sqrt(1 + Math.pow(r, 2 * order));
    }
    return h;
  }

  function ormsbyH(f, f1, f2, f3, f4) {
    if (f <= f1 || f >= f4) return 0;
    const trap = (a, b, c, d) => {
      if (f < b) return 0.5 * (1 - Math.cos(Math.PI * (f - a) / (b - a)));
      if (f <= c) return 1;
      return 0.5 * (1 + Math.cos(Math.PI * (f - c) / (d - c)));
    };
    return Math.max(0, Math.min(1, trap(f1, f2, f3, f4)));
  }

  function applySpectral(x, ns, N, Hfn, scratch) {
    const half = (N >> 1) + 1;
    const re = scratch.re, im = scratch.im, buf = scratch.buf;
    buf.fill(0);
    for (let i = 0; i < ns; i++) buf[i] = x[i];
    rfft(buf, N, re, im);
    for (let k = 0; k < half; k++) {
      const f = k * 1e6 / (N * scratch.dtMicro);
      const h = Hfn(f, k);
      re[k] *= h; im[k] *= h;
    }
    irfft(re, im, N, buf, scratch.fullRe, scratch.fullIm);
    return buf.subarray(0, ns);
  }

  // ------------------------------------------------------------ chain pieces
  function agc(x, ns, dtMs, winMs) {
    const w = Math.max(3, Math.round(winMs / dtMs) | 1);
    const halfw = w >> 1;
    const pre = new Float64Array(ns + 1);
    for (let i = 0; i < ns; i++) pre[i + 1] = pre[i] + x[i] * x[i];
    let total = pre[ns];
    const target = Math.sqrt(total / ns) || 1;
    const out = new Float32Array(ns);
    for (let i = 0; i < ns; i++) {
      const a = Math.max(0, i - halfw), b = Math.min(ns, i + halfw + 1);
      const ms = (pre[b] - pre[a]) / (b - a);
      const rms = Math.sqrt(ms) || 1e-12;
      const g = Math.min(200, target / rms);
      out[i] = x[i] * g;
    }
    return out;
  }

  function tgain(x, ns, dtMs, power, t0ms) {
    const out = new Float32Array(ns);
    for (let i = 0; i < ns; i++) {
      const t = i * dtMs + t0ms;
      out[i] = x[i] * Math.pow(Math.max(t, dtMs) / 1000, power);
    }
    return out;
  }

  function shift(x, ns, samples) {
    const out = new Float32Array(ns);
    const s = Math.round(samples);
    for (let i = 0; i < ns; i++) {
      const j = i - s;
      if (j >= 0 && j < ns) out[i] = x[j];
    }
    return out;
  }

  function mute(x, ns, dtMs, topMs, botMs, rampMs) {
    const out = Float32Array.from(x.subarray(0, ns));
    const top = Math.max(0, topMs / dtMs);
    const bot = botMs > 0 ? botMs / dtMs : ns;
    const ramp = Math.max(1, rampMs / dtMs);
    for (let i = 0; i < ns; i++) {
      let g = 1;
      if (i < top) g = 0;
      else if (i < top + ramp) g = (i - top) / ramp;
      if (i > bot) g = 0;
      else if (i > bot - ramp) g = Math.min(g, (bot - i) / ramp);
      out[i] *= Math.max(0, Math.min(1, g));
    }
    return out;
  }

  function normalize(x, ns, mode, target) {
    let a = 0;
    if (mode === 'max') { for (let i = 0; i < ns; i++) a = Math.max(a, Math.abs(x[i])); }
    else { let s = 0; for (let i = 0; i < ns; i++) s += x[i] * x[i]; a = Math.sqrt(s / ns); }
    if (a < 1e-20) return Float32Array.from(x.subarray(0, ns));
    const g = (target || 1) / a;
    const out = new Float32Array(ns);
    for (let i = 0; i < ns; i++) out[i] = x[i] * g;
    return out;
  }

  function medianFilter(x, ns, w) {
    const h = w >> 1;
    const out = new Float32Array(ns);
    const tmp = [];
    for (let i = 0; i < ns; i++) {
      tmp.length = 0;
      for (let j = i - h; j <= i + h; j++) tmp.push(j >= 0 && j < ns ? x[j] : 0);
      tmp.sort((a, b) => a - b);
      out[i] = tmp[h];
    }
    return out;
  }

  function envelope(x, ns, N, scratch) {
    const half = (N >> 1) + 1;
    const re = scratch.re, im = scratch.im, buf = scratch.buf;
    const fr = scratch.fullRe, fi = scratch.fullIm;
    buf.fill(0);
    for (let i = 0; i < ns; i++) buf[i] = x[i];
    rfft(buf, N, re, im);
    fr.fill(0); fi.fill(0);
    fr[0] = re[0];
    for (let k = 1; k < half - 1; k++) { fr[k] = 2 * re[k]; fi[k] = 2 * im[k]; }
    fr[half - 1] = re[half - 1];
    fft(fr, fi, N, true);
    const out = new Float32Array(ns);
    for (let i = 0; i < ns; i++) out[i] = Math.hypot(fr[i], fi[i]);
    return out;
  }

  // predictive / spiking deconvolution in the frequency domain (Wiener).
  // Filter is estimated from a windowed copy, then applied to the raw spectrum.
  function spectralDecon(x, ns, N, scratch, opts) {
    const half = (N >> 1) + 1;
    const re = scratch.re, im = scratch.im, buf = scratch.buf;
    const est = new Float64Array(N);
    for (let i = 0; i < ns; i++) est[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (ns - 1)));
    rfft(est, N, re, im);
    const P = new Float64Array(half);
    let pmax = 0;
    for (let k = 0; k < half; k++) { P[k] = re[k] * re[k] + im[k] * im[k]; if (P[k] > pmax) pmax = P[k]; }
    if (pmax <= 0) return Float32Array.from(x.subarray(0, ns));

    const df = 1e6 / (N * scratch.dtMicro);
    const w = Math.max(1, Math.round((opts.smoothHz || 10) / df));
    const S = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = Math.max(0, k - w), b = Math.min(half, k + w + 1);
      let s = 0;
      for (let j = a; j < b; j++) s += P[j];
      S[k] = s / (b - a);
    }
    const eps = Math.max(1e-30, (opts.noise || 0.01) * pmax);
    const strength = opts.strength == null ? 1 : opts.strength;
    const H = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const num = Math.pow(S[k], strength);
      H[k] = Math.min(50, num / Math.max(num + eps, 1e-30));
    }

    buf.fill(0);
    for (let i = 0; i < ns; i++) buf[i] = x[i];
    rfft(buf, N, re, im);
    for (let k = 0; k < half; k++) { re[k] *= H[k]; im[k] *= H[k]; }
    irfft(re, im, N, buf, scratch.fullRe, scratch.fullIm);
    return Float32Array.from(buf.subarray(0, ns));
  }

  function spectralWhiten(x, ns, N, scratch, opts) {
    const half = (N >> 1) + 1;
    const re = scratch.re, im = scratch.im, buf = scratch.buf;
    buf.fill(0);
    for (let i = 0; i < ns; i++) buf[i] = x[i];
    rfft(buf, N, re, im);
    const A = new Float64Array(half);
    let amax = 0;
    for (let k = 0; k < half; k++) { A[k] = Math.hypot(re[k], im[k]); if (A[k] > amax) amax = A[k]; }
    if (amax <= 0) return Float32Array.from(x.subarray(0, ns));
    const df = 1e6 / (N * scratch.dtMicro);
    const w = Math.max(1, Math.round((opts.smoothHz || 20) / df));
    const strength = opts.strength == null ? 0.7 : opts.strength;
    for (let k = 0; k < half; k++) {
      const a = Math.max(0, k - w), b = Math.min(half, k + w + 1);
      let s = 0;
      for (let j = a; j < b; j++) s += A[j];
      const sm = s / (b - a);
      const target = Math.max(amax * 0.02, 1e-30);
      let h = Math.pow(Math.max(sm, target) / Math.max(A[k], target), strength);
      h = Math.min(20, Math.max(0.05, h));
      re[k] *= h; im[k] *= h;
    }
    irfft(re, im, N, buf, scratch.fullRe, scratch.fullIm);
    return Float32Array.from(buf.subarray(0, ns));
  }

  // ------------------------------------------------------------ chain driver
  const PER_TRACE = new Set(['agc', 'tgain', 'bandpass', 'ormsby', 'notch', 'decon', 'whiten',
    'shift', 'mute', 'normalize', 'median', 'envelope', 'scale']);

  function makeScratch(N, dtMicro) {
    return {
      re: new Float64Array((N >> 1) + 1),
      im: new Float64Array((N >> 1) + 1),
      buf: new Float64Array(N),
      fullRe: new Float64Array(N),
      fullIm: new Float64Array(N),
      dtMicro
    };
  }

  function applyTraceStep(x, ns, step, dtMs, dtMicro, N, sc) {
    const p = step.params || {};
    switch (step.type) {
      case 'agc': return agc(x, ns, dtMs, p.window || 100);
      case 'tgain': return tgain(x, ns, dtMs, p.power == null ? 1 : p.power, p.t0 || 0);
      case 'bandpass':
        return applySpectral(x, ns, N, f => butterH(f, p.low || 0, p.high || 0, p.order || 4), sc);
      case 'ormsby':
        return applySpectral(x, ns, N, f => ormsbyH(f, p.f1 || 10, p.f2 || 30, p.f3 || 120, p.f4 || 200), sc);
      case 'notch':
        return applySpectral(x, ns, N, f => {
          const d = (f - (p.freq || 50)) / (p.width || 5);
          return 1 - Math.exp(-0.5 * d * d) * (p.depth == null ? 1 : p.depth);
        }, sc);
      case 'whiten': return spectralWhiten(x, ns, N, sc, p);
      case 'decon': return spectralDecon(x, ns, N, sc, p);
      case 'shift': return shift(x, ns, (p.ms || 0) / dtMs);
      case 'mute': return mute(x, ns, dtMs, p.top || 0, p.bottom || 0, p.ramp == null ? 10 : p.ramp);
      case 'normalize': return normalize(x, ns, p.mode || 'rms', p.target || 1);
      case 'median': return medianFilter(x, ns, p.window || 3);
      case 'envelope': return envelope(x, ns, N, sc);
      case 'scale': {
        const g = p.factor == null ? 1 : p.factor;
        const out = new Float32Array(ns);
        for (let i = 0; i < ns; i++) out[i] = x[i] * g;
        return out;
      }
      default: return x;
    }
  }

  async function applyChain(ds, src, steps, opts) {
    opts = opts || {};
    const n = ds.traceCount, maxNs = ds.maxNs;
    const N = nextPow2(Math.max(16, maxNs));
    const sc = makeScratch(N, ds.dt);
    const dtMs = ds.dt / 1000;
    let cur = Float32Array.from(src);
    const enabled = steps.filter(s => s.enabled !== false);
    const onProgress = opts.onProgress || (() => {});
    const token = opts.token || {};

    for (let si = 0; si < enabled.length; si++) {
      const step = enabled[si];
      if (token.cancelled) throw new Error('cancelled');
      if (step.type === 'mix') {
        const p = step.params || {};
        const k = Math.max(1, Math.min(9, Math.round(p.traces || 3)));
        const half = k >> 1;
        const w = p.weight == null ? 0.5 : p.weight;
        const tmp = new Float32Array(cur.length);
        for (let t = 0; t < n; t++) {
          const ns = ds.nsArr[t] || maxNs, base = t * maxNs;
          for (let i = 0; i < ns; i++) {
            let s = 0, cnt = 0;
            for (let j = -half; j <= half; j++) {
              if (j === 0) continue;
              const tt = t + j;
              if (tt < 0 || tt >= n) continue;
              s += cur[tt * maxNs + i];
              cnt++;
            }
            tmp[base + i] = (1 - w) * cur[base + i] + (cnt ? w * s / cnt : 0);
          }
          if ((t & 63) === 0) {
            onProgress((si + t / n) / enabled.length, step.type, si, enabled.length);
            if (opts.yield !== false) await new Promise(r => setTimeout(r, 0));
            if (token.cancelled) throw new Error('cancelled');
          }
        }
        cur = tmp;
        continue;
      }
      if (!PER_TRACE.has(step.type)) continue;
      const tmp = new Float32Array(cur.length);
      for (let t = 0; t < n; t++) {
        const ns = ds.nsArr[t] || maxNs, base = t * maxNs;
        const srcTrace = cur.subarray(base, base + ns);
        const res = applyTraceStep(srcTrace, ns, step, dtMs, ds.dt, N, sc);
        tmp.set(res, base);
        if ((t & 31) === 0) {
          onProgress((si + t / n) / enabled.length, step.type, si, enabled.length);
          if (opts.yield !== false) await new Promise(r => setTimeout(r, 0));
          if (token.cancelled) throw new Error('cancelled');
        }
      }
      cur = tmp;
    }
    onProgress(1, 'done', enabled.length, enabled.length);
    return cur;
  }

  // ------------------------------------------------------------ QC utilities
  function spectrumOf(x, ns, dtMicro, N) {
    N = N || nextPow2(Math.max(64, ns));
    const half = (N >> 1) + 1;
    const re = new Float64Array(half), im = new Float64Array(half);
    const buf = new Float64Array(N);
    for (let i = 0; i < ns; i++) buf[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (ns - 1)));
    rfft(buf, N, re, im);
    const amp = new Float64Array(half), freq = new Float64Array(half);
    const df = 1e6 / (N * dtMicro);
    for (let k = 0; k < half; k++) { amp[k] = Math.hypot(re[k], im[k]); freq[k] = k * df; }
    return { freq, amp, df, N };
  }

  function spectrumAverage(ds, data, t0, t1, dtMicro) {
    const N = nextPow2(Math.max(64, ds.maxNs));
    const half = (N >> 1) + 1;
    const acc = new Float64Array(half);
    let cnt = 0;
    const step = Math.max(1, Math.floor((t1 - t0) / 40));
    for (let t = t0; t < t1; t += step) {
      const ns = ds.nsArr[t] || ds.maxNs, base = t * ds.maxNs;
      const s = spectrumOf(data.subarray(base, base + ns), ns, dtMicro, N);
      for (let k = 0; k < half; k++) acc[k] += s.amp[k];
      cnt++;
    }
    const df = 1e6 / (N * dtMicro);
    const amp = new Float64Array(half);
    for (let k = 0; k < half; k++) amp[k] = cnt ? acc[k] / cnt : 0;
    return { amp, df };
  }

  function autocorr(x, ns, maxLag) {
    maxLag = Math.min(maxLag || 200, ns - 1);
    const out = new Float64Array(maxLag + 1);
    let e0 = 0;
    for (let i = 0; i < ns; i++) e0 += x[i] * x[i];
    if (e0 <= 0) return out;
    for (let l = 0; l <= maxLag; l++) {
      let s = 0;
      for (let i = 0; i < ns - l; i++) s += x[i] * x[i + l];
      out[l] = s / e0;
    }
    return out;
  }

  root.DSP = {
    fft, rfft, irfft, nextPow2, plan,
    agc, tgain, shift, mute, normalize, medianFilter, envelope,
    spectralDecon, spectralWhiten, butterH, ormsbyH,
    applyChain, applyTraceStep, makeScratch,
    spectrumOf, spectrumAverage, autocorr
  };
})(typeof window !== 'undefined' ? window : globalThis);
