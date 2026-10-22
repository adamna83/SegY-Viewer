/* app.js — UI wiring for SEG-Y Studio */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const VU = window.ViewerUtil;

  // ---------------------------------------------------------------- step defs
  const STEP_DEFS = {
    bandpass: { label: 'Band-pass (Butterworth)', params: {
      low: { label: 'Low cut (Hz)', def: 80, min: 0, max: 5000, step: 5 },
      high: { label: 'High cut (Hz)', def: 1200, min: 10, max: 20000, step: 10 },
      order: { label: 'Order', def: 4, min: 1, max: 8, step: 1 } } },
    ormsby: { label: 'Ormsby filter', params: {
      f1: { label: 'f1 (Hz)', def: 10, min: 0, max: 5000, step: 1 },
      f2: { label: 'f2 (Hz)', def: 30, min: 0, max: 5000, step: 1 },
      f3: { label: 'f3 (Hz)', def: 120, min: 0, max: 5000, step: 1 },
      f4: { label: 'f4 (Hz)', def: 200, min: 0, max: 5000, step: 1 } } },
    notch: { label: 'Notch', params: {
      freq: { label: 'Frequency (Hz)', def: 50, min: 1, max: 5000, step: 1 },
      width: { label: 'Width (Hz)', def: 5, min: 0.5, max: 200, step: 0.5 },
      depth: { label: 'Depth 0–1', def: 1, min: 0, max: 1, step: 0.05 } } },
    decon: { label: 'Spectral deconvolution', params: {
      noise: { label: 'Noise 0–1', def: 0.01, min: 0.0001, max: 0.5, step: 0.001 },
      smoothHz: { label: 'Smooth (Hz)', def: 20, min: 1, max: 200, step: 1 },
      strength: { label: 'Strength', def: 1, min: 0.1, max: 2, step: 0.1 } } },
    whiten: { label: 'Spectral whitening', params: {
      smoothHz: { label: 'Smooth (Hz)', def: 20, min: 1, max: 200, step: 1 },
      strength: { label: 'Strength', def: 0.7, min: 0, max: 1, step: 0.05 } } },
    agc: { label: 'AGC', params: {
      window: { label: 'Window (ms)', def: 100, min: 4, max: 5000, step: 4 } } },
    tgain: { label: 'T^n gain', params: {
      power: { label: 'Power n', def: 1, min: 0, max: 4, step: 0.1 },
      t0: { label: 'Start t (ms)', def: 0, min: 0, max: 5000, step: 1 } } },
    shift: { label: 'Static shift', params: {
      ms: { label: 'Shift (ms)', def: 0, min: -1000, max: 1000, step: 1 } } },
    mute: { label: 'Mute', params: {
      top: { label: 'Top (ms)', def: 0, min: 0, max: 5000, step: 1 },
      bottom: { label: 'Bottom (ms)', def: 0, min: 0, max: 20000, step: 1 },
      ramp: { label: 'Taper (ms)', def: 10, min: 0, max: 500, step: 1 } } },
    normalize: { label: 'Normalize', params: {
      target: { label: 'Target RMS', def: 1, min: 0.0001, max: 1e9, step: 0.1 } } },
    median: { label: 'Median filter', params: {
      window: { label: 'Window (samples)', def: 3, min: 3, max: 21, step: 2 } } },
    mix: { label: 'Trace mix', params: {
      traces: { label: 'Traces', def: 3, min: 3, max: 9, step: 2 },
      weight: { label: 'Weight 0–1', def: 0.5, min: 0, max: 1, step: 0.05 } } },
    envelope: { label: 'Envelope (Hilbert)', params: {} },
    scale: { label: 'Scale', params: {
      factor: { label: 'Factor', def: 1, min: -1000, max: 1000, step: 0.1 } } }
  };

  const PRESETS = {
    sparker: [
      { type: 'bandpass', enabled: true, params: { low: 120, high: 1000, order: 4 } },
      { type: 'decon', enabled: true, params: { noise: 0.02, smoothHz: 30, strength: 1 } },
      { type: 'agc', enabled: true, params: { window: 80 } },
      { type: 'mute', enabled: true, params: { top: 5, bottom: 0, ramp: 4 } }
    ],
    hr2d: [
      { type: 'bandpass', enabled: true, params: { low: 15, high: 300, order: 4 } },
      { type: 'decon', enabled: true, params: { noise: 0.01, smoothHz: 8, strength: 1 } },
      { type: 'agc', enabled: true, params: { window: 250 } }
    ],
    minimal: [
      { type: 'bandpass', enabled: true, params: { low: 20, high: 1500, order: 4 } }
    ]
  };

  const HEADER_CHOICES = ['sp', 'cdp', 'offset', 'dist', 'trace', 'waterDepth',
    'sensorDepth', 'receiverElev', 'x', 'y'];

  // ---------------------------------------------------------------- state
  const state = { files: [], active: -1, mode: 'original', busy: false, token: null };
  let viewer = null;
  let specTimer = null;
  let drag = null;

  // ---------------------------------------------------------------- helpers
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmt = VU.fmtNum;

  function active() { return state.active >= 0 ? state.files[state.active] : null; }

  function cloneP(obj) { return JSON.parse(JSON.stringify(obj)); }

  function baseName(name) { return name.replace(/\.(sgy|segy)$/i, ''); }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2600);
    setTimeout(() => el.remove(), 3200);
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

  // ---------------------------------------------------------------- loading
  async function loadFiles(list) {
    const files = Array.from(list || []).filter(f => /\.(sgy|segy)$/i.test(f.name));
    if (!files.length) { toast('No .sgy / .segy files in that selection'); return; }
    let added = 0;
    for (const file of files) {
      try {
        setProgress(0, 'Parsing ' + file.name);
        $('progWrap').hidden = false;
        const ab = await file.arrayBuffer();
        const ds = SEGY.parse(ab, file.name);
        addDataset(ds, file.name);
        added++;
      } catch (err) {
        console.error(err);
        toast('Could not read ' + file.name + ': ' + err.message, 'bad');
      }
    }
    $('progWrap').hidden = true;
    if (added) toast(added + ' file' + (added > 1 ? 's' : '') + ' loaded');
  }

  function addDataset(ds, name) {
    const f = {
      ds, name, original: ds.data, processed: null,
      chain: defaultChain(ds)
    };
    state.files.push(f);
    renderFileList();
    selectFile(state.files.length - 1);
  }

  function defaultChain(ds) {
    const sparker = ds.dt <= 120;           // 51 µs sparker vs 500 µs HR
    return cloneP(sparker ? PRESETS.sparker : PRESETS.hr2d);
  }

  function renderFileList() {
    const el = $('fileList');
    $('fileCount').textContent = state.files.length + (state.files.length === 1 ? ' file' : ' files');
    if (!state.files.length) {
      el.innerHTML = '<div class="empty">No files loaded.<br><span class="muted small">Drop .sgy files anywhere or use Open files.</span></div>';
      return;
    }
    el.innerHTML = '';
    state.files.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'fileitem' + (i === state.active ? ' on' : '');
      d.title = f.name;
      d.innerHTML = `<span class="nm"></span><span class="meta">${f.ds.traceCount} tr · ${mb(f.ds.size)}</span><button class="x" title="Remove">×</button>`;
      d.querySelector('.nm').textContent = f.name;
      d.addEventListener('click', e => {
        if (e.target.classList.contains('x')) return;
        selectFile(i);
      });
      d.querySelector('.x').addEventListener('click', e => {
        e.stopPropagation();
        removeFile(i);
      });
      el.appendChild(d);
    });
  }

  function removeFile(i) {
    state.files.splice(i, 1);
    if (state.active === i) state.active = -1;
    else if (state.active > i) state.active--;
    renderFileList();
    if (state.active >= 0) selectFile(state.active);
    else clearUI();
  }

  function clearUI() {
    viewer.setDataset(null, null);
    viewer.draw();
    $('info').textContent = 'Nothing loaded.';
    $('traceInfo').textContent = 'Click the section to inspect a trace.';
    $('textHead').textContent = '—';
    $('modeSeg').hidden = true;
    $('exportSegyBtn').disabled = true;
    $('exportPngBtn').disabled = true;
    $('exportCsvBtn').disabled = true;
    $('applyBtn').disabled = true;
    clearSpec();
    $('readout').textContent = '—';
    $('viewinfo').textContent = '';
  }

  function selectFile(i) {
    if (i < 0 || i >= state.files.length) return;
    if (state.busy) { toast('Processing in progress — cancel or wait'); return; }
    state.active = i;
    state.mode = 'original';
    const f = state.files[i];
    viewer.setDataset(f.ds, f.original);
    renderFileList();
    renderChain();
    updateInfo(f);
    updateTextHead(f);
    updateMode();
    updateHeaderChoices(f);
    refreshSpec();
    $('exportSegyBtn').disabled = false;
    $('exportPngBtn').disabled = false;
    $('exportCsvBtn').disabled = false;
    $('applyBtn').disabled = !f.chain.some(s => s.enabled !== false);
    updateViewInfo();
  }

  // ---------------------------------------------------------------- info panels
  function kv(obj) {
    const dl = document.createElement('dl');
    dl.className = 'kv';
    for (const [k, v] of obj) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    return dl;
  }

  function updateInfo(f) {
    const ds = f.ds;
    const rec = ds.maxNs * ds.dt / 1000;
    const el = $('info');
    el.innerHTML = '';
    el.classList.remove('muted', 'small');
    el.appendChild(kv([
      ['File', f.name],
      ['Size', mb(ds.size)],
      ['Traces', fmt(ds.traceCount)],
      ['Samples', fmt(ds.maxNs) + (ds.variableNs ? ' (variable)' : '')],
      ['Sample rate', ds.dt + ' µs'],
      ['Record length', rec.toFixed(1) + ' ms'],
      ['Format', ds.format + ' · ' + ds.formatName],
      ['Byte order', ds.endian],
      ['Text header', ds.textEncoding],
      ['Coordinates', ds.usableCoords ? 'used for distance' : 'not usable'],
      ['Line length', fmt(ds.totalDist) + ' m'],
      ['Delay', fmt(ds.delayMs) + ' ms'],
      ['Amplitude', '±' + fmt(ds.stats.max)]
    ]));
  }

  function updateTextHead(f) {
    $('textHead').textContent = f.ds.textLines.join('\n');
  }

  function updateHeaderChoices(f) {
    const sel = $('headerSel');
    sel.innerHTML = '';
    const defs = SEGY.FIELD_DEFS.filter(d => HEADER_CHOICES.includes(d.key));
    defs.push({ key: 'dist', name: 'Distance along line' });
    for (const d of defs) {
      const o = document.createElement('option');
      o.value = d.key; o.textContent = d.name;
      sel.appendChild(o);
    }
    const chosen = chooseHeader(f.ds);
    sel.value = chosen;
    viewer.opt.header = chosen;
  }

  function variance(a) {
    if (!a || !a.length) return 0;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < a.length; i += Math.max(1, (a.length / 500) | 0)) {
      const v = a[i];
      if (!isFinite(v)) continue;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    return mx - mn;
  }

  function chooseHeader(ds) {
    for (const k of ['sp', 'cdp', 'offset', 'waterDepth', 'dist']) {
      const a = k === 'dist' ? ds.dist : ds.fields[k];
      if (a && variance(a) > 0) return k;
    }
    return 'trace';
  }

  function traceInfoFor(t, s) {
    const f = active(); if (!f) return;
    const ds = f.ds;
    const tIdx = clamp(Math.round(t), 0, ds.traceCount - 1);
    const sIdx = clamp(Math.round(s), 0, ds.maxNs - 1);
    const fl = ds.fields;
    const val = sIdx < (ds.nsArr[tIdx] || ds.maxNs)
      ? currentData()[tIdx * ds.maxNs + sIdx] : 0;
    const g = (k, dflt = '—') => fl[k] ? fmt(fl[k][tIdx]) : dflt;
    const el = $('traceInfo');
    el.innerHTML = '';
    el.appendChild(kv([
      ['Trace', String(tIdx)],
      ['SP', g('sp')],
      ['CDP', g('cdp')],
      ['Offset', g('offset')],
      ['X / Y', g('x') + ' / ' + g('y')],
      ['Sensor depth', g('sensorDepth')],
      ['Water depth', g('waterDepth')],
      ['Delay', g('delay') + ' ms'],
      ['Samples', String(ds.nsArr[tIdx] || ds.maxNs)],
      ['Distance', fmt(ds.dist[tIdx]) + ' m'],
      ['Time', (sIdx * ds.dt / 1000).toFixed(2) + ' ms'],
      ['Amplitude', fmt(val)]
    ]));
  }

  function currentData() {
    const f = active();
    if (!f) return new Float32Array(0);
    return (state.mode === 'processed' && f.processed) ? f.processed : f.original;
  }

  function updateViewInfo() {
    const f = active(); if (!f) return;
    const v = viewer.view;
    $('viewinfo').textContent = `${f.ds.dt} µs · ${f.ds.maxNs} samples · traces ` +
      `${Math.round(v.t0)}–${Math.round(v.t1)} of ${f.ds.traceCount}`;
  }

  // ---------------------------------------------------------------- chain UI
  function renderChain() {
    const f = active();
    const el = $('chain');
    el.innerHTML = '';
    if (!f) { $('chainCount').textContent = 'empty'; return; }
    $('chainCount').textContent = f.chain.length ? f.chain.length + ' steps' : 'empty';
    f.chain.forEach((step, idx) => {
      const def = STEP_DEFS[step.type]; if (!def) return;
      const box = document.createElement('div');
      box.className = 'step' + (step.enabled === false ? ' off' : '');

      const head = document.createElement('div');
      head.className = 'sh';
      const chk = document.createElement('input');
      chk.type = 'checkbox'; chk.checked = step.enabled !== false;
      chk.addEventListener('change', () => {
        step.enabled = chk.checked;
        box.classList.toggle('off', !chk.checked);
        $('applyBtn').disabled = !f.chain.some(s => s.enabled !== false);
      });      const b = document.createElement('b'); b.textContent = def.label;
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '×'; del.title = 'Remove step';
      del.addEventListener('click', () => {
        f.chain.splice(idx, 1);
        renderChain();
        $('applyBtn').disabled = !f.chain.some(s => s.enabled !== false);
      });
      head.appendChild(chk); head.appendChild(b); head.appendChild(del);
      box.appendChild(head);

      const pdefs = Object.entries(def.params || {});
      if (pdefs.length) {
        const sp = document.createElement('div');
        sp.className = 'sp';
        for (const [pk, pd] of pdefs) {
          const lab = document.createElement('label');
          lab.textContent = pd.label;
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.min = pd.min; inp.max = pd.max; inp.step = pd.step;
          inp.value = step.params && step.params[pk] != null ? step.params[pk] : pd.def;
          inp.addEventListener('input', () => {
            const v = parseFloat(inp.value);
            if (!isFinite(v)) return;
            step.params = step.params || {};
            step.params[pk] = v;
          });
          sp.appendChild(lab); sp.appendChild(inp);
        }
        box.appendChild(sp);
      }
      el.appendChild(box);
    });
  }

  function addStep(type) {
    const f = active(); if (!f || !STEP_DEFS[type]) return;
    const params = {};
    for (const [k, p] of Object.entries(STEP_DEFS[type].params)) params[k] = p.def;
    f.chain.push({ type, enabled: true, params });
    renderChain();
    $('applyBtn').disabled = false;
  }

  // ---------------------------------------------------------------- processing
  async function applyChain() {
    const f = active();
    if (!f || state.busy) return;
    const steps = f.chain.filter(s => s.enabled !== false);
    if (!steps.length) { toast('Chain is empty'); return; }
    state.busy = true;
    state.token = { cancelled: false };
    const started = Date.now();
    setBusy(true);
    $('progWrap').hidden = false;
    setProgress(0, 'starting');
    try {
      const out = await DSP.applyChain(f.ds, f.original, steps, {
        onProgress: (p, type) => setProgress(p, type)
      });
      f.processed = out;
      state.mode = 'processed';
      viewer.setData(out);
      updateMode();
      refreshSpec();
      setProgress(1, 'done');
      toast('Chain applied in ' + (Date.now() - started) + ' ms');
    } catch (err) {
      if (err && err.message === 'cancelled') toast('Processing cancelled', 'warn');
      else { console.error(err); toast('Processing failed: ' + err.message, 'bad'); }
    } finally {
      state.busy = false;
      setBusy(false);
      setTimeout(() => { if (!state.busy) $('progWrap').hidden = true; }, 700);
    }
  }

  function setBusy(b) {
    $('applyBtn').disabled = b;
    $('cancelBtn').disabled = !b;
    $('clearBtn').disabled = b;
    $('addStepBtn').disabled = b;
    $('presetBtn').disabled = b;
    document.querySelectorAll('.step input, .step .del, .step input[type=checkbox]')
      .forEach(el => { el.disabled = b; });
  }

  function setProgress(p, label) {
    $('progBar').style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
    $('progText').textContent = (label || '') + ' · ' + Math.round(clamp(p, 0, 1) * 100) + '%';
  }

  function updateMode() {
    const f = active();
    const has = !!(f && f.processed);
    $('modeSeg').hidden = !has;
    document.querySelectorAll('#modeSeg button').forEach(b => {
      b.classList.toggle('on', b.dataset.mode === state.mode);
    });
  }

  function setMode(mode) {
    const f = active(); if (!f) return;
    if (mode === 'processed' && !f.processed) return;
    state.mode = mode;
    viewer.setData(currentData());
    updateMode();
    refreshSpec();
  }

  // ---------------------------------------------------------------- spectrum
  function clearSpec() {
    const c = $('spec');
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0c1a17';
    ctx.fillRect(0, 0, c.width, c.height);
    $('specNote').textContent = '';
  }

  function refreshSpec() {
    const f = active();
    const c = $('spec');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0c1a17'; ctx.fillRect(0, 0, w, h);
    if (!f) { $('specNote').textContent = ''; return; }
    const v = viewer.view;
    const t0 = clamp(Math.floor(v.t0), 0, f.ds.traceCount - 1);
    const t1 = clamp(Math.ceil(v.t1), t0 + 1, f.ds.traceCount);
    const cur = DSP.spectrumAverage(f.ds, currentData(), t0, t1, f.ds.dt);
    const orig = (f.processed && state.mode === 'processed')
      ? DSP.spectrumAverage(f.ds, f.original, t0, t1, f.ds.dt) : null;
    const nyq = 1e6 / (2 * f.ds.dt);
    let top = 0;
    for (let i = 1; i < cur.amp.length; i++) if (cur.amp[i] > top) top = cur.amp[i];
    if (orig) for (let i = 1; i < orig.amp.length; i++) if (orig.amp[i] > top) top = orig.amp[i];
    if (!(top > 0)) { $('specNote').textContent = 'No data in view'; return; }
    const logTop = Math.log10(top), logMin = logTop - 5;
    const X = fq => (fq / nyq) * (w - 8) + 4;
    const Y = a => h - 4 - ((Math.log10(Math.max(a, 1e-30)) - logMin) / (logTop - logMin)) * (h - 14);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.fillStyle = 'rgba(235,245,243,0.6)';
    ctx.font = `${Math.round(9 * dpr)}px Inter, sans-serif`;
    ctx.lineWidth = 1;
    for (let fq = 0; fq <= nyq; fq += niceFreq(nyq)) {
      const x = X(fq);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 10); ctx.stroke();
      ctx.fillText(Math.round(fq), x + 2, h - 1);
    }
    ctx.fillStyle = 'rgba(235,245,243,0.45)';
    ctx.fillText('Hz', w - 18, 10 * dpr);

    if (orig) drawCurve(orig.amp, 'rgba(200,215,212,0.55)');
    drawCurve(cur.amp, '#00a19c');

    function drawCurve(amp, color) {
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      const step = Math.max(1, Math.floor(amp.length / (w * 2)));
      for (let i = 0, first = true; i < amp.length; i += step) {
        const x = X(i * cur.df), y = Y(amp[i]);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    $('specNote').textContent = `Average of traces ${t0}–${t1} · Nyquist ${Math.round(nyq)} Hz` +
      (orig ? ' · grey = original' : '');
  }

  function niceFreq(nyq) {
    const raw = nyq / 6;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  function scheduleSpec() {
    clearTimeout(specTimer);
    specTimer = setTimeout(refreshSpec, 450);
  }

  // ---------------------------------------------------------------- export
  function exportSegy() {
    const f = active(); if (!f) return;
    const data = currentData();
    const fmt = [1, 2, 3, 5].includes(f.ds.format) ? f.ds.format : 5;
    try {
      const blob = SEGY.write(f.ds, data, f.ds.maxNs, f.ds.dt, fmt, {
        encoding: f.ds.textEncoding === 'ebcdic' ? 'ebcdic' : 'ascii'
      });
      const suffix = state.mode === 'processed' ? '_proc' : '_orig';
      download(blob, baseName(f.name) + suffix + '.sgy');
      toast('SEG-Y exported' + (fmt !== f.ds.format ? ' (format ' + fmt + ')' : ''));
    } catch (err) {
      console.error(err);
      toast('Export failed: ' + err.message, 'bad');
    }
  }

  function exportPng() {
    const f = active(); if (!f) return;
    viewer.seis.toBlob(b => {
      if (b) download(b, baseName(f.name) + '_section.png');
    }, 'image/png');
  }

  function exportCsv() {
    const f = active(); if (!f) return;
    const ds = f.ds;
    const defs = SEGY.FIELD_DEFS.map(d => d.key);
    const lines = [['traceIndex'].concat(defs).concat(['dist']).join(',')];
    for (let t = 0; t < ds.traceCount; t++) {
      const row = [t];
      for (const k of defs) row.push(ds.fields[k] ? ds.fields[k][t] : '');
      row.push(ds.dist[t].toFixed(3));
      lines.push(row.join(','));
    }
    download(new Blob([lines.join('\n')], { type: 'text/csv' }), baseName(f.name) + '_headers.csv');
  }

  // ---------------------------------------------------------------- server browse
  function openModal(title) {
    $('modalTitle').textContent = title;
    $('modal').hidden = false;
  }

  function closeModal() { $('modal').hidden = true; }

  const DEFAULT_PATH = 'Z:\\06.GHO\\06.Report Registration\\2026\\Site Survey';

  async function browse(path) {
    const body = $('modalBody');
    body.innerHTML = '';
    const crumbs = document.createElement('div');
    crumbs.className = 'crumbs';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = path || DEFAULT_PATH;
    const go = document.createElement('button');
    go.className = 'btn'; go.textContent = 'Go';
    const up = document.createElement('button');
    up.className = 'btn ghost'; up.textContent = '↑ Up';
    crumbs.appendChild(input); crumbs.appendChild(go); crumbs.appendChild(up);
    body.appendChild(crumbs);
    const list = document.createElement('div');
    list.className = 'browse';
    list.innerHTML = '<div class="muted small">Loading…</div>';
    body.appendChild(list);

    async function load(p) {
      list.innerHTML = '<div class="muted small">Loading…</div>';
      try {
        const r = await fetch('/api/list?path=' + encodeURIComponent(p));
        if (!r.ok) throw new Error((await r.text()) || ('HTTP ' + r.status));
        const j = await r.json();
        input.value = j.path;
        state.serverPath = j.path;
        render(j);
      } catch (err) {
        list.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'muted small';
        d.textContent = 'Cannot list folder: ' + err.message;
        list.appendChild(d);
      }
    }

    function render(j) {
      list.innerHTML = '';
      if (j.parent) {
        const d = item('..', 'dir');
        d.addEventListener('click', () => load(j.parent));
        list.appendChild(d);
      }
      for (const dir of j.dirs) {
        const d = item(dir.name + '/', 'dir');
        d.addEventListener('click', () => load(dir.path));
        list.appendChild(d);
      }
      for (const file of j.files) {
        const d = item(file.name, 'file');
        const sz = document.createElement('span');
        sz.className = 'sz'; sz.textContent = mb(file.size);
        d.appendChild(sz);
        d.addEventListener('click', () => loadRemote(file.path, file.name));
        list.appendChild(d);
      }
      if (!j.dirs.length && !j.files.length) {
        list.innerHTML = '<div class="muted small">Empty folder.</div>';
      }
    }

    function item(label, kind) {
      const d = document.createElement('div');
      d.className = 'it ' + kind;
      d.textContent = label;
      return d;
    }

    go.addEventListener('click', () => load(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') load(input.value); });
    up.addEventListener('click', () => { if (state.serverPath) load(state.serverPath.replace(/[\\/][^\\/]+$/, '')); });
    openModal('Browse survey drive');
    await load(path || state.serverPath || DEFAULT_PATH);
  }

  async function loadRemote(path, name) {
    try {
      closeModal();
      $('progWrap').hidden = false;
      setProgress(0.2, 'Downloading ' + name);
      const r = await fetch('/api/file?path=' + encodeURIComponent(path));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ab = await r.arrayBuffer();
      setProgress(0.7, 'Parsing ' + name);
      const ds = SEGY.parse(ab, name);
      addDataset(ds, name);
      $('progWrap').hidden = true;
      toast(name + ' loaded');
    } catch (err) {
      console.error(err);
      $('progWrap').hidden = true;
      toast('Load failed: ' + err.message, 'bad');
    }
  }

  // ---------------------------------------------------------------- interaction
  function canvasPos(e) {
    const r = viewer.seis.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * viewer.seis.width / r.width,
      y: (e.clientY - r.top) * viewer.seis.height / r.height
    };
  }

  function wireViewer() {
    const c = viewer.seis;

    c.addEventListener('wheel', e => {
      if (!active()) return;
      e.preventDefault();
      const p = canvasPos(e);
      const fx = p.x / c.width, fy = p.y / c.height;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const axis = (e.ctrlKey || e.altKey) ? 'trace' : 'time';
      viewer.zoom(factor, fx, fy, axis);
      updateReadout(lastMouse);
      updateViewInfo();
      scheduleSpec();
    }, { passive: false });

    c.addEventListener('pointerdown', e => {
      if (!active()) return;
      if (e.button !== 0) return;
      const p = canvasPos(e);
      drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, shift: e.shiftKey, moved: false };
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener('pointermove', e => {
      if (!active()) return;
      const p = canvasPos(e);
      lastMouse = p;
      if (drag) {
        const dx = p.x - drag.x, dy = p.y - drag.y;
        if (Math.abs(p.x - drag.x0) + Math.abs(p.y - drag.y0) > 3) drag.moved = true;
        if (drag.shift) {
          drag.x = p.x; drag.y = p.y;
          viewer.box = { x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y };
          viewer.draw();
        } else {
          drag.x = p.x; drag.y = p.y;
          viewer.pan(dx, dy);
          updateViewInfo();
        }
      }
      updateReadout(p);
    });

    c.addEventListener('pointerup', e => {
      if (!drag) return;
      const p = canvasPos(e);
      if (drag.shift && drag.moved) {
        viewer.zoomToBox(viewer.box || { x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y });
        viewer.box = null;
        viewer.draw();
        updateViewInfo();
      } else if (!drag.moved) {
        const d = viewer.pxToData(p.x, p.y);
        viewer.setCursor(d.trace, d.sample);
        traceInfoFor(d.trace, d.sample);
        updateReadout(p);
      }
      drag = null;
      scheduleSpec();
    });

    c.addEventListener('pointercancel', () => { drag = null; viewer.box = null; viewer.draw(); });

    c.addEventListener('dblclick', () => {
      if (!active()) return;
      viewer.resetView();
      viewer.cursor = null;
      scheduleSpec();
      updateViewInfo();
    });

    c.addEventListener('pointerleave', () => {
      if (!drag) { $('readout').textContent = '—'; }
    });
  }

  let lastMouse = null;

  function updateReadout(p) {
    if (!p || !active()) return;
    const f = active(), ds = f.ds;
    const d = viewer.pxToData(p.x, p.y);
    const t = clamp(Math.round(d.trace), 0, ds.traceCount - 1);
    const s = clamp(Math.round(d.sample), 0, ds.maxNs - 1);
    const ns = ds.nsArr[t] || ds.maxNs;
    const data = currentData();
    const val = s < ns ? data[t * ds.maxNs + s] : 0;
    const sp = ds.fields.sp ? ' · SP ' + fmt(ds.fields.sp[t]) : '';
    $('readout').textContent = `trace ${t}${sp} · ${(s * ds.dt / 1000).toFixed(2)} ms · ` +
      `amp ${fmt(val)} · dist ${fmt(ds.dist[t])} m`;
    updateViewInfo();
  }

  // ---------------------------------------------------------------- init
  function init() {
    viewer = new Viewer($('seis'), $('hdr'), $('axis'));
    window.viewer = viewer;

    wireViewer();

    // file pickers
    $('openBtn').addEventListener('click', () => $('fileInput').click());
    $('folderBtn').addEventListener('click', () => $('folderInput').click());
    $('fileInput').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
    $('folderInput').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });

    // server browse (only when the local Python server answers)
    const isHttp = /^https?:$/.test(location.protocol);
    $('serverBtn').hidden = true;
    $('enginePill').textContent = 'offline';
    $('serverBtn').addEventListener('click', () => browse(state.serverPath));
    $('modalClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });

    // display controls
    $('gainSel').addEventListener('change', () => {
      viewer.opt.gain = $('gainSel').value;
      $('agcGrp').hidden = viewer.opt.gain !== 'agc';
      $('tgainGrp').hidden = viewer.opt.gain !== 'tgain';
      $('clipGrp').hidden = viewer.opt.gain === 'agc';
      viewer.draw();
    });
    $('tgainPow').addEventListener('input', () => {
      const v = parseFloat($('tgainPow').value);
      if (isFinite(v) && v >= 0) { viewer.opt.tgain = v; viewer.draw(); }
    });
    $('clipPct').addEventListener('input', () => {
      const v = parseFloat($('clipPct').value);
      if (v >= 80 && v < 100) { viewer.opt.clipPct = v; viewer.draw(); }
    });
    $('agcWin').addEventListener('input', () => {
      const v = parseFloat($('agcWin').value);
      if (v >= 5) { viewer.opt.agcWin = v; viewer.draw(); }
    });
    $('cmapSel').addEventListener('change', () => { viewer.opt.cmap = $('cmapSel').value; viewer.draw(); });
    $('wiggleChk').addEventListener('change', () => { viewer.opt.wiggle = $('wiggleChk').checked; viewer.draw(); });
    $('gridChk').addEventListener('change', () => { viewer.opt.grid = $('gridChk').checked; viewer.draw(); });
    $('headerSel').addEventListener('change', () => { viewer.opt.header = $('headerSel').value; viewer.draw(); });

    $('fitBtn').addEventListener('click', () => { viewer.resetView(); updateViewInfo(); scheduleSpec(); });
    $('zTimeIn').addEventListener('click', () => { viewer.zoom(1.6, 0.5, 0.5, 'time'); updateViewInfo(); });
    $('zTimeOut').addEventListener('click', () => { viewer.zoom(0.625, 0.5, 0.5, 'time'); updateViewInfo(); });
    $('zTraceIn').addEventListener('click', () => { viewer.zoom(1.6, 0.5, 0.5, 'trace'); updateViewInfo(); });
    $('zTraceOut').addEventListener('click', () => { viewer.zoom(0.625, 0.5, 0.5, 'trace'); updateViewInfo(); });

    $('modeSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (b) setMode(b.dataset.mode);
    });

    // chain controls
    const st = $('stepType');
    for (const [k, d] of Object.entries(STEP_DEFS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = d.label;
      st.appendChild(o);
    }
    $('addStepBtn').addEventListener('click', () => addStep(st.value));
    $('clearBtn').addEventListener('click', () => {
      const f = active(); if (!f) return;
      f.chain = []; renderChain(); $('applyBtn').disabled = true;
    });
    $('presetBtn').addEventListener('click', () => {
      const f = active(); const p = $('presetSel').value;
      if (!f || !p) return;
      f.chain = cloneP(PRESETS[p]);
      renderChain();
      $('applyBtn').disabled = false;
    });
    $('applyBtn').addEventListener('click', applyChain);
    $('cancelBtn').addEventListener('click', () => {
      if (state.token) { state.token.cancelled = true; $('progText').textContent = 'cancelling…'; }
    });

    // export
    $('exportSegyBtn').addEventListener('click', exportSegy);
    $('exportPngBtn').addEventListener('click', exportPng);
    $('exportCsvBtn').addEventListener('click', exportCsv);

    // drag + drop (files and folders)
    let dragDepth = 0;
    window.addEventListener('dragenter', e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      dragDepth++; $('dropOverlay').hidden = false;
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('dropOverlay').hidden = true;
    });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault();
      dragDepth = 0; $('dropOverlay').hidden = true;
      if (!e.dataTransfer) return;
      const items = e.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        const entries = [];
        for (const it of items) {
          const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
          if (en) entries.push(en);
        }
        const files = [];
        for (const en of entries) await walkEntry(en, files, 0);
        if (files.length) loadFiles(files);
      } else {
        loadFiles(e.dataTransfer.files);
      }
    });

    function walkEntry(entry, out, depth) {
      return new Promise(resolve => {
        if (!entry || depth > 8) return resolve();
        if (entry.isFile) {
          entry.file(f => { out.push(f); resolve(); }, () => resolve());
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const all = [];
          const read = () => reader.readEntries(async batch => {
            if (!batch.length) {
              for (const en of all) await walkEntry(en, out, depth + 1);
              return resolve();
            }
            all.push(...batch);
            read();
          }, () => resolve());
          read();
        } else resolve();
      });
    }

    // keyboard
    window.addEventListener('keydown', e => {
      if (/input|select|textarea/i.test(e.target.tagName)) return;
      if (!active()) return;
      if (e.key === '+' || e.key === '=') viewer.zoom(1.4, 1.4, 'time');
      else if (e.key === '-') viewer.zoom(0.71, 0.71, 'time');
      else if (e.key.toLowerCase() === 'f') { viewer.resetView(); scheduleSpec(); }
      else if (e.key.toLowerCase() === 'w') { $('wiggleChk').checked = !$('wiggleChk').checked; $('wiggleChk').dispatchEvent(new Event('change')); }
      else if (e.key.toLowerCase() === 'o') setMode('original');
      else if (e.key.toLowerCase() === 'p') setMode('processed');
    });

    // resize
    const ro = new ResizeObserver(() => { viewer.resize(); });
    ro.observe(document.querySelector('.view'));
    window.addEventListener('resize', () => { clearTimeout(specTimer); specTimer = setTimeout(refreshSpec, 350); });

    renderFileList();
    clearUI();
    if (isHttp && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      fetch('/api/ping').then(r => {
        if (!r.ok) throw new Error('static hosting');
        return r.json();
      }).then(j => {
        if (j && j.ok) {
          state.serverPath = j.root;
          $('serverBtn').hidden = false;
          $('enginePill').textContent = 'local server';
        }
      }).catch(() => { /* static hosting: no drive browse */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
