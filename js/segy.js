/* SEG-Y reader/writer — IEEE + IBM float, EBCDIC text, endian detection. */
(function (global) {
  'use strict';

  // EBCDIC code page 037 -> Unicode code points (256 entries, hex)
  const CP037_HEX =
    '0000,0001,0002,0003,009c,0009,0086,007f,0097,008d,008e,000b,000c,000d,000e,000f,' +
    '0010,0011,0012,0013,009d,0085,0008,0087,0018,0019,0092,008f,001c,001d,001e,001f,' +
    '0080,0081,0082,0083,0084,000a,0017,001b,0088,0089,008a,008b,008c,0005,0006,0007,' +
    '0090,0091,0016,0093,0094,0095,0096,0004,0098,0099,009a,009b,0014,0015,009e,001a,' +
    '0020,00a0,00e2,00e4,00e0,00e1,00e3,00e5,00e7,00f1,00a2,002e,003c,0028,002b,007c,' +
    '0026,00e9,00ea,00eb,00e8,00ed,00ee,00ef,00ec,00df,0021,0024,002a,0029,003b,00ac,' +
    '002d,002f,00c2,00c4,00c0,00c1,00c3,00c5,00c7,00d1,00a6,002c,0025,005f,003e,003f,' +
    '00f8,00c9,00ca,00cb,00c8,00cd,00ce,00cf,00cc,0060,003a,0023,0040,0027,003d,0022,' +
    '00d8,0061,0062,0063,0064,0065,0066,0067,0068,0069,00ab,00bb,00f0,00fd,00fe,00b1,' +
    '00b0,006a,006b,006c,006d,006e,006f,0070,0071,0072,00aa,00ba,00e6,00b8,00c6,00a4,' +
    '00b5,007e,0073,0074,0075,0076,0077,0078,0079,007a,00a1,00bf,00d0,00dd,00de,00ae,' +
    '005e,00a3,00a5,00b7,00a9,00a7,00b6,00bc,00bd,00be,005b,005d,00af,00a8,00b4,00d7,' +
    '007b,0041,0042,0043,0044,0045,0046,0047,0048,0049,00ad,00f4,00f6,00f2,00f3,00f5,' +
    '007d,004a,004b,004c,004d,004e,004f,0050,0051,0052,00b9,00fb,00fc,00f9,00fa,00ff,' +
    '005c,00f7,0053,0054,0055,0056,0057,0058,0059,005a,00b2,00d4,00d6,00d2,00d3,00d5,' +
    '0030,0031,0032,0033,0034,0035,0036,0037,0038,0039,00b3,00db,00dc,00d9,00da,009f';

  const CP037 = CP037_HEX.split(',').map(h => String.fromCharCode(parseInt(h, 16)));
  const CP037_INV = (() => {
    const m = new Uint8Array(65536).fill(0x40);
    for (let i = 0; i < 256; i++) {
      const c = CP037[i].charCodeAt(0);
      if (c < 65536) m[c] = i;
    }
    return m;
  })();

  const FORMATS = {
    1: { name: 'IBM 32-bit float', bytes: 4 },
    2: { name: '32-bit integer', bytes: 4 },
    3: { name: '16-bit integer', bytes: 2 },
    4: { name: 'Fixed point with gain', bytes: 4, unsupported: true },
    5: { name: 'IEEE 32-bit float', bytes: 4 },
    6: { name: 'IEEE 64-bit float', bytes: 8 },
    7: { name: '24-bit integer', bytes: 3 },
    8: { name: '8-bit integer', bytes: 1 },
    9: { name: '64-bit integer', bytes: 8 },
    10: { name: '32-bit unsigned int', bytes: 4 },
    11: { name: '16-bit unsigned int', bytes: 2 },
    12: { name: '64-bit unsigned int', bytes: 8 },
    15: { name: '24-bit unsigned int', bytes: 3 },
    16: { name: '8-bit unsigned int', bytes: 1 }
  };

  const FIELD_DEFS = [
    { key: 'trace',        name: 'Trace sequence no.',      bytes: [1, 4],     type: 'i4' },
    { key: 'traceFile',    name: 'Trace no. in file',       bytes: [5, 8],     type: 'i4' },
    { key: 'fieldRecord',  name: 'Field record / FFID',     bytes: [9, 12],    type: 'i4' },
    { key: 'traceInRecord',name: 'Trace no. in record',     bytes: [13, 16],   type: 'i4' },
    { key: 'sp',           name: 'Shot point (ESP)',        bytes: [17, 20],   type: 'i4' },
    { key: 'cdp',          name: 'Ensemble / CDP',          bytes: [21, 24],   type: 'i4' },
    { key: 'traceInEns',   name: 'Trace no. in ensemble',   bytes: [25, 28],   type: 'i4' },
    { key: 'traceId',      name: 'Trace identification',    bytes: [29, 30],   type: 'i2' },
    { key: 'offset',       name: 'Source-receiver offset',  bytes: [37, 40],   type: 'i4' },
    { key: 'receiverElev', name: 'Receiver elevation',      bytes: [41, 44],   type: 'i4' },
    { key: 'sourceElev',   name: 'Source elevation',        bytes: [45, 48],   type: 'i4' },
    { key: 'sensorDepth',  name: 'Source / sensor depth',   bytes: [49, 52],   type: 'i4' },
    { key: 'waterDepth',   name: 'Water depth at source',   bytes: [61, 64],   type: 'i4' },
    { key: 'elevScalar',   name: 'Elevation scalar',        bytes: [69, 70],   type: 'i2' },
    { key: 'coordScalar',  name: 'Coordinate scalar',       bytes: [71, 72],   type: 'i2' },
    { key: 'x',            name: 'Source / CMP X',          bytes: [73, 76],   type: 'i4' },
    { key: 'y',            name: 'Source / CMP Y',          bytes: [77, 80],   type: 'i4' },
    { key: 'gx',           name: 'Group X',                 bytes: [81, 84],   type: 'i4' },
    { key: 'gy',           name: 'Group Y',                 bytes: [85, 88],   type: 'i4' },
    { key: 'coordUnits',   name: 'Coordinate units',        bytes: [89, 90],   type: 'i2' },
    { key: 'delay',        name: 'Delay recording time (ms)', bytes: [109, 110], type: 'i2' },
    { key: 'muteStart',    name: 'Mute time start (ms)',    bytes: [111, 112], type: 'i2' },
    { key: 'muteEnd',      name: 'Mute time end (ms)',      bytes: [113, 114], type: 'i2' },
    { key: 'ns',           name: 'Samples in trace',        bytes: [115, 116], type: 'i2' },
    { key: 'dt',           name: 'Sample interval (µs)',    bytes: [117, 118], type: 'i2' },
    { key: 'cdpX',         name: 'CDP X',                   bytes: [181, 184], type: 'i4' },
    { key: 'cdpY',         name: 'CDP Y',                   bytes: [185, 188], type: 'i4' },
    { key: 'inline',       name: 'Inline 3D',               bytes: [189, 192], type: 'i4' },
    { key: 'xline',        name: 'Crossline 3D',            bytes: [193, 196], type: 'i4' },
    { key: 'shotpoint',    name: 'Shotpoint (rev1)',        bytes: [197, 200], type: 'i4' },
    { key: 'spScalar',     name: 'Shotpoint scalar',        bytes: [201, 202], type: 'i2' },
    { key: 'timeMs',       name: 'Custom time (ms)',        bytes: [233, 234], type: 'i2' },
    { key: 'heave',        name: 'Sensor heave (mm)',       bytes: [235, 236], type: 'i2' }
  ];

  // ---- primitives -------------------------------------------------------
  function i16(b, o, le) {
    const u = le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
    return (u & 0x8000) ? u - 0x10000 : u;
  }
  function u16(b, o, le) {
    return le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  }
  function i32(b, o, le) {
    if (le) return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
    return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }
  function u32(b, o, le) {
    return le
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  }
  function readVal(b, o, type, le) {
    if (type === 'i2') return i16(b, o, le);
    if (type === 'i4') return i32(b, o, le);
    return 0;
  }

  // ---- text header ------------------------------------------------------
  function scoreAscii(bytes) {
    let good = 0;
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0x20 || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) ||
          (c >= 0x61 && c <= 0x7a) || '.,:;/-_()[]%+*=\'"'.indexOf(String.fromCharCode(c)) >= 0) good++;
    }
    return good / bytes.length;
  }
  function scoreEbcdic(bytes) {
    let good = 0;
    for (let i = 0; i < bytes.length; i++) {
      const ch = CP037[bytes[i]];
      const c = ch.charCodeAt(0);
      if (c === 0x20 || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) ||
          (c >= 0x61 && c <= 0x7a) || '.,:;/-_()[]%+*=\'"'.indexOf(ch) >= 0) good++;
    }
    return good / bytes.length;
  }
  function decodeText(bytes) {
    const a = scoreAscii(bytes), e = scoreEbcdic(bytes);
    const enc = e > a ? 'ebcdic' : 'ascii';
    const chars = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      chars[i] = enc === 'ebcdic' ? CP037[bytes[i]] : String.fromCharCode(bytes[i]);
    }
    return { encoding: enc, text: chars.join('') };
  }
  function encodeText(str, encoding) {
    const out = new Uint8Array(3200).fill(encoding === 'ebcdic' ? 0x40 : 0x20);
    for (let i = 0; i < Math.min(3200, str.length); i++) {
      const c = str.charCodeAt(i);
      out[i] = encoding === 'ebcdic'
        ? (c < 65536 ? CP037_INV[c] : 0x40)
        : (c < 256 ? c : 0x20);
    }
    return out;
  }
  function textLines(text) {
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(text.substr(i * 80, 80));
    return lines;
  }

  // ---- IBM float --------------------------------------------------------
  const POW16 = new Float64Array(256);
  for (let e = 0; e < 256; e++) POW16[e] = Math.pow(16, e - 64);
  function ibmToFloat(u) {
    if (u === 0) return 0;
    if (u === 0x80000000) return 0;
    const sign = (u & 0x80000000) ? -1 : 1;
    const exp = (u >>> 24) & 0x7f;
    const mant = u & 0x00ffffff;
    if (mant === 0) return 0;
    return sign * mant * POW16[exp] / 16777216;
  }
  function floatToIbm(x) {
    if (!isFinite(x) || x === 0) return 0;
    const sign = x < 0 ? 0x80000000 : 0;
    let ax = Math.abs(x);
    let exp = 64;
    while (ax < 0.0625) { ax *= 16; exp--; }
    while (ax >= 1) { ax /= 16; exp++; }
    let mant = Math.round(ax * 16777216);
    if (mant > 0xffffff) { mant = 0xffffff; }
    return (sign | ((exp & 0x7f) << 24) | (mant & 0xffffff)) >>> 0;
  }

  // ---- binary header ----------------------------------------------------
  const BIN_FIELDS = [
    ['jobId', 1, 'i4'], ['lineNumber', 5, 'i4'], ['reelNumber', 9, 'i4'],
    ['tracesPerEnsemble', 13, 'i2'], ['auxTraces', 15, 'i2'],
    ['dt', 17, 'i2'], ['dtOriginal', 19, 'i2'], ['ns', 21, 'i2'], ['nsOriginal', 23, 'i2'],
    ['format', 25, 'i2'], ['ensembleFold', 27, 'i2'], ['traceSorting', 29, 'i2'],
    ['measurementSystem', 55, 'i2'], ['segyRevision', 301, 'i2'],
    ['fixedLength', 303, 'i2'], ['extTextHeaders', 305, 'i2']
  ];
  function parseBinary(b, le) {
    const o = {};
    for (const [k, off, t] of BIN_FIELDS) o[k] = readVal(b, off - 1, t, le);
    return o;
  }

  // ---- detection --------------------------------------------------------
  function detectEndian(bytes) {
    const score = le => {
      const ns = u16(bytes, 20, le);
      const dt = u16(bytes, 16, le);
      const fmt = u16(bytes, 24, le);
      let s = 0;
      if (ns > 0 && ns <= 500000) s += 3; else s -= 6;
      if (dt > 0 && dt <= 100000) s += 2; else s -= 4;
      if (FORMATS[fmt]) s += 3; else s -= 6;
      return s;
    };
    return score(false) >= score(true) ? 'big' : 'little';
  }

  function parse(buffer, name, opts) {
    opts = opts || {};
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 3600) throw new Error('File is too small to be a SEG-Y file.');
    const le = (opts.endian || detectEndian(bytes.subarray(3200, 3600))) === 'little';

    const dec = decodeText(bytes.subarray(0, 3200));
    const binaryRaw = Uint8Array.from(bytes.subarray(3200, 3600));
    const binary = parseBinary(bytes.subarray(3200, 3600), le);

    let format = binary.format;
    if (!FORMATS[format]) throw new Error('Unsupported SEG-Y sample format code: ' + format);
    if (FORMATS[format].unsupported) throw new Error('SEG-Y format 4 (fixed point with gain) is not supported.');
    const bps = FORMATS[format].bytes;

    let ns = binary.ns;
    let dt = binary.dt || 1;

    // extended textual headers
    const ext = binary.segyRevision >= 1 ? Math.max(0, binary.extTextHeaders || 0) : 0;
    let dataStart = 3600 + ext * 3200;
    if (dataStart > bytes.length) dataStart = 3600;

    if (!ns || ns <= 0) {
      // peek first trace header
      if (dataStart + 240 <= bytes.length) {
        ns = readVal(bytes, dataStart + 114, 'i2', le);
      }
      if (!ns || ns <= 0) throw new Error('Cannot determine samples per trace (ns).');
      binary.ns = ns;
    }

    const fixed = binary.fixedLength === 1 || binary.segyRevision === 0;
    let traceLength = 240 + ns * bps;
    let traceCount;

    if (fixed) {
      traceCount = Math.floor((bytes.length - dataStart) / traceLength);
    } else {
      // variable-length: walk headers
      traceCount = 0;
      let p = dataStart;
      while (p + 240 <= bytes.length) {
        const tns = readVal(bytes, p + 114, 'i2', le);
        if (!tns || tns <= 0) break;
        p += 240 + tns * bps;
        traceCount++;
      }
    }
    if (traceCount <= 0) throw new Error('No traces found in file.');

    // header block + variable geometry
    const headers = new Uint8Array(traceCount * 240);
    const offsets = new Int32Array(traceCount);
    const nsArr = new Uint16Array(traceCount);
    let maxNs = ns;
    let p = dataStart;
    for (let i = 0; i < traceCount; i++) {
      offsets[i] = p;
      headers.set(bytes.subarray(p, p + 240), i * 240);
      const tns = readVal(bytes, p + 114, 'i2', le) || ns;
      nsArr[i] = tns;
      if (tns > maxNs) maxNs = tns;
      p += 240 + (fixed ? ns * bps : tns * bps);
      if (!fixed && p > bytes.length) { traceCount = i + 1; break; }
    }

    // ---- sample decode ----
    const data = new Float32Array(traceCount * maxNs);
    decodeAll(bytes, data, headers, offsets, nsArr, traceCount, maxNs, ns, bps, format, le);

    const fields = extractFields(headers, traceCount, le, nsArr, dt);

    // coordinate scalars
    applyScalar(fields.x, fields.coordScalar, 73);
    applyScalar(fields.y, fields.coordScalar, 77);

    // distance along line (metres) using coordinates if they look sane
    const dist = new Float64Array(traceCount);
    const usable = fields.x.length && coordLooksSane(fields.x, fields.y);
    let acc = 0;
    for (let i = 0; i < traceCount; i++) {
      if (i > 0) {
        if (usable) acc += Math.hypot(fields.x[i] - fields.x[i - 1], fields.y[i] - fields.y[i - 1]);
        else acc += 1;
      }
      dist[i] = acc;
    }

    // stats over a representative subset
    const stats = computeStats(data, nsArr, traceCount, maxNs);

    const ds = {
      name: name || 'Untitled',
      size: bytes.length,
      endian: le ? 'little' : 'big',
      text: dec.text,
      textEncoding: dec.encoding,
      textLines: textLines(dec.text),
      binary,
      binaryRaw,
      revision: binary.segyRevision,
      format,
      formatName: FORMATS[format].name,
      bytesPerSample: bps,
      ns,
      maxNs,
      dt,
      dataStart,
      traceCount,
      headers,
      offsets,
      nsArr,
      data,
      fields,
      dist,
      totalDist: traceCount ? dist[traceCount - 1] : 0,
      stats,
      usableCoords: usable,
      delayMs: fields.delay.length ? median(fields.delay) : 0
    };
    ds.fields.dist = dist;
    return ds;
  }

  function decodeAll(bytes, data, headers, offsets, nsArr, n, maxNs, defNs, bps, fmt, le) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let t = 0; t < n; t++) {
      const base = offsets[t] + 240;
      const ns = nsArr[t] || defNs;
      const out = t * maxNs;
      if (fmt === 5) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getFloat32(base + i * 4, le);
      } else if (fmt === 1) {
        for (let i = 0; i < ns; i++) {
          data[out + i] = ibmToFloat(dv.getUint32(base + i * 4, le));
        }
      } else if (fmt === 3) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getInt16(base + i * 2, le);
      } else if (fmt === 2) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getInt32(base + i * 4, le);
      } else if (fmt === 8) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getInt8(base + i);
      } else if (fmt === 6) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getFloat64(base + i * 8, le);
      } else if (fmt === 9) {
        for (let i = 0; i < ns; i++) {
          const hi = dv.getInt32(base + i * 8, le), lo = dv.getUint32(base + i * 8 + 4, le);
          data[out + i] = hi * 4294967296 + lo;
        }
      } else if (fmt === 10) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getUint32(base + i * 4, le);
      } else if (fmt === 11) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getUint16(base + i * 2, le);
      } else if (fmt === 16) {
        for (let i = 0; i < ns; i++) data[out + i] = dv.getUint8(base + i);
      } else if (fmt === 7 || fmt === 15) {
        const uns = fmt === 15;
        for (let i = 0; i < ns; i++) {
          const o = base + i * 3;
          const v = uns
            ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) >>> 0
            : (le ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16))
                  : ((bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]));
          data[out + i] = (!uns && v & 0x800000) ? v - 0x1000000 : v;
        }
      } else if (fmt === 12) {
        for (let i = 0; i < ns; i++) {
          const hi = dv.getUint32(base + i * 8, le), lo = dv.getUint32(base + i * 8 + 4, le);
          data[out + i] = hi * 4294967296 + lo;
        }
      }
    }
  }

  function extractFields(headers, n, le, nsArr, dt) {
    const out = {};
    for (const f of FIELD_DEFS) {
      const arr = f.type === 'i2' && (f.key === 'ns') ? new Uint16Array(n)
        : (f.type === 'i4' ? new Int32Array(n) : new Int32Array(n));
      const o = f.bytes[0] - 1;
      for (let i = 0; i < n; i++) arr[i] = readVal(headers, i * 240 + o, f.type, le);
      out[f.key] = arr;
    }
    // if the standard ESP is empty but the field record is populated, use it
    let zeroSp = 0;
    for (let i = 0; i < n; i++) if (!out.sp[i]) zeroSp++;
    if (zeroSp > n * 0.9) {
      let nz = 0;
      for (let i = 0; i < n; i++) if (out.fieldRecord[i]) nz++;
      if (nz > n * 0.5) out.sp = Int32Array.from(out.fieldRecord);
    }
    if (!dt) dt = 1000;
    return out;
  }

  function applyScalar(arr, scalarArr, offset) {
    if (!arr || !arr.length) return;
    let sc = scalarArr && scalarArr.length ? scalarArr[0] : 1;
    // some files store the scalar only in the first trace
    if (!sc) {
      for (let i = 0; i < scalarArr.length; i++) if (scalarArr[i]) { sc = scalarArr[i]; break; }
    }
    sc = sc || 1;
    const mul = sc < 0 ? 1 / Math.abs(sc) : sc;
    for (let i = 0; i < arr.length; i++) arr[i] = arr[i] * mul;
  }

  function coordLooksSane(x, y) {
    let ok = 0, n = Math.min(x.length, 200);
    for (let i = 0; i < n; i++) {
      if (Math.abs(x[i]) > 1000 && Math.abs(y[i]) > 1000 &&
          Math.abs(x[i]) < 1e8 && Math.abs(y[i]) < 1e8) ok++;
    }
    return ok > n * 0.7;
  }

  function computeStats(data, nsArr, n, maxNs) {
    let min = Infinity, max = -Infinity, sum2 = 0, sumAbs = 0, cnt = 0;
    const step = Math.max(1, Math.floor(n / 400));
    for (let t = 0; t < n; t += step) {
      const ns = nsArr[t] || maxNs, base = t * maxNs;
      for (let i = 0; i < ns; i += 2) {
        const v = data[base + i];
        if (!isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum2 += v * v; sumAbs += Math.abs(v); cnt++;
      }
    }
    if (!cnt) return { min: 0, max: 0, rms: 0, meanAbs: 0 };
    return { min, max, rms: Math.sqrt(sum2 / cnt), meanAbs: sumAbs / cnt };
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = Array.from(arr).sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)];
  }

  // ---- writer -----------------------------------------------------------
  function write(ds, data, ns, dt, formatOut, opts) {
    opts = opts || {};
    const fmt = formatOut || 5;
    const bps = FORMATS[fmt].bytes;
    const n = ds.traceCount;
    const useNs = ns || ds.ns;

    let text = ds.text;
    if (opts.updateText !== false) {
      const recMs = (useNs * dt) / 1000;
      const c11 = ('C11 Sample Interval: ' + dt + ' microSecond       Record Length: ' +
        recMs.toFixed(3) + ' milliSecond').padEnd(80, ' ');
      text = text.substr(0, 800) + c11 + text.substr(880);
    }
    const textBytes = encodeText(text, opts.encoding || 'ascii');

    const binary = new Uint8Array(400);
    if (ds.binaryRaw) binary.set(ds.binaryRaw);
    const set16 = (off, v) => { binary[off - 1] = (v >> 8) & 255; binary[off] = v & 255; };
    const set32 = (off, v) => {
      binary[off - 1] = (v >>> 24) & 255; binary[off] = (v >>> 16) & 255;
      binary[off + 1] = (v >>> 8) & 255; binary[off + 2] = v & 255;
    };
    set16(17, dt);
    set16(21, useNs);
    set16(25, fmt);
    set16(303, 1);
    set16(301, 1);
    if (!ds.binaryRaw) {
      set32(3201, ds.binary.jobId || 0);
      set32(3205, ds.binary.lineNumber || 0);
      set32(3209, ds.binary.reelNumber || 0);
      set16(13, ds.binary.tracesPerEnsemble || 1);
      set16(55, ds.binary.measurementSystem || 1);
    }

    const traceLen = 240 + useNs * bps;
    const out = new Uint8Array(3600 + traceLen * n);
    out.set(textBytes, 0);
    out.set(binary, 3200);

    const dv = new DataView(out.buffer);
    for (let t = 0; t < n; t++) {
      const base = 3600 + t * traceLen;
      out.set(ds.headers.subarray(t * 240, t * 240 + 240), base);
      out[base + 114] = (useNs >> 8) & 255; out[base + 115] = useNs & 255;
      out[base + 116] = (dt >> 8) & 255; out[base + 117] = dt & 255;
      const src = t * ds.maxNs;
      const dst = base + 240;
      if (fmt === 5) {
        for (let i = 0; i < useNs; i++) dv.setFloat32(dst + i * 4, data[src + i] || 0, false);
      } else if (fmt === 1) {
        for (let i = 0; i < useNs; i++) dv.setUint32(dst + i * 4, floatToIbm(data[src + i] || 0), false);
      } else if (fmt === 3) {
        for (let i = 0; i < useNs; i++) dv.setInt16(dst + i * 2, Math.max(-32768, Math.min(32767, Math.round(data[src + i]))), false);
      } else if (fmt === 2) {
        for (let i = 0; i < useNs; i++) dv.setInt32(dst + i * 4, Math.max(-2147483648, Math.min(2147483647, Math.round(data[src + i]))), false);
      }
    }
    return new Blob([out], { type: 'application/octet-stream' });
  }

  global.SEGY = {
    parse, write, decodeText, encodeText, ibmToFloat, floatToIbm,
    FORMATS, FIELD_DEFS, BIN_FIELDS, CP037
  };
})(typeof window !== 'undefined' ? window : globalThis);
