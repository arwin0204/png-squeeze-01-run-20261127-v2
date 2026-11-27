// png-squeeze: rewrite each 1280x720 RGBA screenshot as the smallest lossless PNG it can be.
//
// Approach (all written from scratch in this file, Node built-ins only):
//   1. Decode the input PNG (colour type 6, stored) to RGBA.
//   2. Analyse the pixels: opaque? grey? at most 256 distinct colours? one transparent key value?
//   3. Screen the lossless forms that hold the image exactly -- palette (colour type 3, by count,
//      by luminance and by RGB), grey (0), grey+alpha (4), RGB (2), RGBA (6), with a tRNS key when every
//      non-opaque pixel shares one fully transparent value -- each with per-row filter
//      choices (None, or brute force: every filter of every row compressed by zlib against the 32 KiB
//      written before it, smallest kept). The winner is the smallest by zlib level 6, like the kit's
//      own scale compressor.
//   4. Final compression: the winner's filtered data re-compressed with zlib level 9 (three settings,
//      smallest kept) and with an optimal-parse DEFLATE of this file's own (hash-chain LZ77 matches,
//      forward dynamic programming, dynamic Huffman tables per 100 KiB block); the optimal stream is
//      kept only when it is smaller and inflates back to exactly the filtered data. The PNG holds a
//      single IDAT chunk and only IHDR / PLTE / tRNS / IDAT / IEND, bit depth 8, non-interlaced.
//
// Deterministic: no clock, no randomness, no environment reads beyond the input/output dirs.
// Budgeted by fixed work, not by time, so two runs write identical bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/* ---------------- PNG plumbing: CRC-32, chunk assembly, IHDR ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/* ---------------- PNG decoding (the formats the contest's inputs use) ---------------- */

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface Decoded {
  rgba: Uint8Array;
  width: number;
  height: number;
}

function decodePng(bytes: Uint8Array): Decoded {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error(`unexpected chunk ${type}`);
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  if (bpp === undefined) throw new Error(`colour type ${colourType}`);
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error(`inflated ${raw.length}, expected ${expected}`);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`row ${y} filter ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++)
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = key !== -1 && samples[s] === trns![1] && samples[s + 1] === trns![3] && samples[s + 2] === trns![5] ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[i];
      rgba[d + 3] = samples[i] === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    // colour type 3: palette
    if (palette === null) throw new Error('palette PNG without PLTE');
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const idx = samples[i] * 3;
      rgba[d] = palette[idx];
      rgba[d + 1] = palette[idx + 1];
      rgba[d + 2] = palette[idx + 2];
      rgba[d + 3] = trns !== null && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return { rgba, width, height };
}

/* ---------------- Image analysis ---------------- */

interface Colour {
  rgba: [number, number, number, number];
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 distinct colours
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const u32 = new Uint32Array(aligned.buffer, aligned.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]] as [number, number, number, number], word: c, count: counts.get(c) as number };
    });
  }
  return { opaque, grey, colours };
}

/** The one fully transparent value the image may key by tRNS instead of an alpha channel. */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/* ---------------- Forms: colour type + samples ---------------- */

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours: Colour[], order: string): Colour[] {
  const lum = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'rgb') return x.rgba[0] - y.rgba[0] || x.rgba[1] - y.rgba[1] || x.rgba[2] - y.rgba[2] || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): PaletteForm {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const u32 = new Uint32Array(aligned.buffer, aligned.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: Array<number | string>;
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
      ['rgb', [0, 'minsum', 'brute']],
    ] as Array<[string, Array<number | string>]>) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 'brute'],
  });
  return forms;
}

/* ---------------- Filtering ---------------- */

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 6;

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else
        cost = deflateSync(trial[t], {
          level: BRUTE_LEVEL,
          memLevel: 9,
          ...(before.length === 0 ? {} : { dictionary: before }),
        }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

/* ---------------- Screening + final compression ---------------- */

const SCREEN = { level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY };

const chunkBytes = (form: Form): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

interface Screened {
  form: Form;
  data: Uint8Array;
  bytes: number;
}

function screen(rgba: Uint8Array, width: number, height: number): Screened {
  let best: Screened | null = null;
  for (const form of formsOf(rgba)) {
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice as FilterChoice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunkBytes(form);
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  return best as Screened;
}

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/* ---------------- Optimal-parse DEFLATE (zopfli-style, written from scratch) ----------------
 * Node's zlib level 9 is a greedy/lazy matcher; an optimal parse over LZ77 matches with
 * dynamic Huffman tables per block squeezes a few percent more out of the same filtered
 * data. Every step is deterministic (fixed work, no clock, no randomness). The stream is
 * validated by inflating it again before it is used; any failure keeps zlib's stream. */

// Length / distance code tables (RFC 1951 section 3.2.5).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Int16Array(259);
const LEN_EXT = new Int16Array(259);
for (let s = 0; s < 29; s++) {
  const next = s === 28 ? 259 : LEN_BASE[s + 1];
  for (let l = LEN_BASE[s]; l < next; l++) {
    LEN_SYM[l] = 257 + s;
    LEN_EXT[l] = LEN_EXTRA[s];
  }
}
const DIST_SYM = new Int16Array(32769);
const DIST_EXT = new Int16Array(32769);
for (let s = 0; s < 30; s++) {
  const next = s === 29 ? 32769 : DIST_BASE[s + 1];
  for (let d = DIST_BASE[s]; d < next; d++) {
    DIST_SYM[d] = s;
    DIST_EXT[d] = DIST_EXTRA[s];
  }
}
// The only match lengths worth considering: within one length code the bit cost is the
// same, so the longest length of each code's range dominates the shorter ones.
const LEN_OPTS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 30, 34, 42, 50, 58, 66, 82, 98, 114, 130, 162, 194, 226, 257, 258];

// Fixed Huffman code lengths (RFC 1951 section 3.2.6).
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT_LEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT_LEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT_LEN[i] = 8;

/** Adler-32 (zlib's) of bytes. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Code lengths (at most maxBits) for `freq`, by Huffman + a Kraft repair. */
function huffmanLengths(freq: ArrayLike<number>, maxBits: number): Uint8Array {
  const n = freq.length;
  const lens = new Int16Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return new Uint8Array(n);
  if (syms.length === 1) {
    lens[syms[0]] = 1;
    return Uint8Array.from(lens);
  }
  const m = syms.length;
  const weight: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < m; i++) {
    weight.push(freq[syms[i]]);
    left.push(-1);
    right.push(-1);
  }
  const heap: number[] = [];
  const hLess = (a: number, b: number): boolean => weight[a] < weight[b] || (weight[a] === weight[b] && a < b);
  const hPush = (x: number): void => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!hLess(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const hPop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && hLess(heap[l], heap[s])) s = l;
        if (r < heap.length && hLess(heap[r], heap[s])) s = r;
        if (s === i) break;
        const t = heap[i];
        heap[i] = heap[s];
        heap[s] = t;
        i = s;
      }
    }
    return top;
  };
  for (let i = 0; i < m; i++) hPush(i);
  let nodes = m;
  while (heap.length > 1) {
    const a = hPop();
    const b = hPop();
    weight.push(weight[a] + weight[b]);
    left.push(a);
    right.push(b);
    hPush(nodes++);
  }
  const root = hPop();
  const depth = new Int16Array(nodes);
  const stack = [root];
  depth[root] = 0;
  while (stack.length > 0) {
    const x = stack.pop() as number;
    if (left[x] === -1) {
      lens[syms[x]] = depth[x];
      continue;
    }
    depth[left[x]] = depth[x] + 1;
    depth[right[x]] = depth[x] + 1;
    stack.push(left[x], right[x]);
  }
  // Cap at maxBits, then repair the Kraft sum by lengthening the least frequent
  // codes that still have room; any length multiset with Kraft sum <= 1 is a
  // valid prefix code, and canonical assignment builds it.
  const limit = 1 << maxBits;
  let kraft = 0;
  for (let i = 0; i < m; i++) {
    const s = syms[i];
    if (lens[s] > maxBits) lens[s] = maxBits;
    kraft += 1 << (maxBits - lens[s]);
  }
  if (kraft > limit) {
    const order = [...syms].sort((a, b) => freq[a] - freq[b] || a - b);
    let guard = 0;
    while (kraft > limit && guard++ < 10000) {
      let picked = -1;
      for (const s of order) {
        if (lens[s] < maxBits) {
          picked = s;
          break;
        }
      }
      if (picked === -1) break;
      kraft -= 1 << (maxBits - lens[picked] - 1);
      lens[picked]++;
    }
  }
  return Uint8Array.from(lens);
}

/** Canonical Huffman codes from code lengths. */
function canonicalCodes(lens: ArrayLike<number>): { codes: Int32Array; lens: Uint8Array } {
  const n = lens.length;
  const outLens = new Uint8Array(n);
  const codes = new Int32Array(n);
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (lens[i] > 0) order.push(i);
  order.sort((a, b) => lens[a] - lens[b] || a - b);
  let code = 0;
  let prevLen = 0;
  for (const s of order) {
    const len = lens[s];
    code <<= len - prevLen;
    codes[s] = code;
    outLens[s] = len;
    code++;
    prevLen = len;
  }
  return { codes, lens: outLens };
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | ((code >> i) & 1);
  }
  return r;
}

/** LSB-first bit writer over a growing byte buffer. */
class BitWriter {
  bytes: Uint8Array;
  pos = 0;
  bitbuf = 0;
  bitcnt = 0;
  constructor(capacity: number) {
    this.bytes = new Uint8Array(Math.max(1024, capacity));
  }
  ensure(n: number): void {
    if (this.pos + n > this.bytes.length) {
      const nb = new Uint8Array(Math.max(this.bytes.length * 2, this.pos + n));
      nb.set(this.bytes.subarray(0, this.pos));
      this.bytes = nb;
    }
  }
  /** Write `count` bits of `value`, least significant bit first. */
  write(value: number, count: number): void {
    this.bitbuf += value * (1 << this.bitcnt);
    this.bitcnt += count;
    while (this.bitcnt >= 8) {
      this.ensure(1);
      this.bytes[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf = Math.floor(this.bitbuf / 256);
      this.bitcnt -= 8;
    }
  }
  /** Write a Huffman code (stored most significant bit first) of `len` bits. */
  writeCode(code: number, len: number): void {
    this.write(reverseBits(code, len), len);
  }
  finish(): Uint8Array {
    if (this.bitcnt > 0) {
      this.ensure(1);
      this.bytes[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
    return this.bytes.subarray(0, this.pos);
  }
}

interface Matches {
  len: Int32Array;
  dist: Int32Array;
}

/**
 * Longest LZ77 match at every position (hash chains, at most 128 candidates).
 * A match found at one position carries to the next: a match of length L at
 * distance D starting at pos implies a match of length L-1 at the same distance
 * starting at pos+1, and the carried match is extended again while the bytes
 * agree, so a continuing run keeps its full length instead of decaying by one
 * a position (a decay would force the parse into many short matches). The chain
 * walk still runs, seeded with the carry: it keeps the longest match, and among
 * equal lengths the closest distance, so a nearer occurrence is never missed
 * for a farther carried one. The carried occurrence itself is skipped (its
 * length is already known), and once the length is maximal only a closer
 * candidate can help, so the walk stops at the first candidate no closer.
 */
function findMatches(data: Uint8Array): Matches {
  const n = data.length;
  const mlen = new Int32Array(n);
  const mdist = new Int32Array(n);
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  let carryLen = 0;
  let carryDist = 0;
  for (let pos = 0; pos < n; pos++) {
    if (pos + 2 >= n) break;
    const x = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
    const h = (((x * 2654435761) >>> 0) >>> 16) & 0xffff;
    const prevHead = head[h];
    head[h] = pos;
    prev[pos] = prevHead;
    const maxLen = Math.min(258, n - pos);
    if (carryLen >= 3) {
      while (carryLen < maxLen && data[pos + carryLen] === data[pos - carryDist + carryLen]) carryLen++;
    }
    // Chain walk, seeded with the carried match when there is one. The chain
    // budget shrinks once a good match is found (zlib's good-length rule), so
    // long matches cost few candidates and short ones get a wide search.
    let bestLen = carryLen >= 3 ? carryLen : 0;
    let bestDist = carryLen >= 3 ? carryDist : 0;
    const skipDist = carryLen >= 3 ? carryDist : -1;
    let cand = prevHead;
    let chain = 0;
    let maxChain = 256;
    while (cand >= 0 && chain < maxChain) {
      const dist = pos - cand;
      if (dist > 32768) break;
      if (bestLen >= maxLen && dist >= bestDist) break;
      if (dist !== skipDist) {
        if (bestLen === 0 || data[cand + bestLen] === data[pos + bestLen]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[pos + l]) l++;
          if (l > bestLen || (l === bestLen && dist < bestDist)) {
            bestLen = l;
            bestDist = dist;
            if (bestLen >= 128) maxChain = Math.min(maxChain, 64);
            else if (bestLen >= 32) maxChain = Math.min(maxChain, 128);
            if (l >= maxLen) break;
          }
        }
      }
      cand = prev[cand];
      chain++;
    }
    if (bestLen >= 3) {
      mlen[pos] = bestLen;
      mdist[pos] = bestDist;
      carryLen = bestLen - 1;
      carryDist = bestDist;
    } else {
      mlen[pos] = 0;
      carryLen = 0;
      carryDist = 0;
    }
  }
  return { len: mlen, dist: mdist };
}

interface Costs {
  lit: Float64Array;
  len: Float64Array;
  dist: Float64Array;
}

function fixedCosts(): Costs {
  const lit = new Float64Array(256);
  for (let i = 0; i < 256; i++) lit[i] = FIXED_LIT_LEN[i];
  const len = new Float64Array(259);
  for (let l = 3; l <= 258; l++) len[l] = FIXED_LIT_LEN[LEN_SYM[l]] + LEN_EXT[l];
  const dist = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) dist[d] = 5 + DIST_EXT[d];
  return { lit, len, dist };
}

function dynamicCosts(freqLit: ArrayLike<number>, freqDist: ArrayLike<number>): Costs {
  const litLens = huffmanLengths(freqLit, 15);
  const distLens = huffmanLengths(freqDist, 15);
  const lit = new Float64Array(256);
  for (let i = 0; i < 256; i++) lit[i] = litLens[i] === 0 ? 15 : litLens[i];
  const len = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const c = litLens[LEN_SYM[l]];
    len[l] = (c === 0 ? 15 : c) + LEN_EXT[l];
  }
  const dist = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const c = distLens[DIST_SYM[d]];
    dist[d] = (c === 0 ? 15 : c) + DIST_EXT[d];
  }
  return { lit, len, dist };
}

interface Symbols {
  kind: Uint8Array; // 0 literal, 1 match
  a: Int32Array; // literal byte, or match length
  b: Int32Array; // match distance (matches only)
  count: number;
}

/** Cheapest literal/match parse of `data` under `costs`, by forward dynamic programming. */
function optimalParse(data: Uint8Array, costs: Costs, m: Matches): Symbols {
  const n = data.length;
  const cost = new Float64Array(n + 1);
  const from = new Int32Array(n + 1);
  const mLen = new Int16Array(n + 1);
  const mDist = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) cost[i] = Infinity;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    const cl = ci + costs.lit[data[i]];
    if (cl < cost[i + 1]) {
      cost[i + 1] = cl;
      from[i + 1] = i;
      mLen[i + 1] = 0;
    }
    const L = m.len[i];
    if (L >= 3) {
      const dc = costs.dist[m.dist[i]];
      for (let k = 0; k < LEN_OPTS.length; k++) {
        const l = LEN_OPTS[k];
        if (l > L) break;
        const c = ci + costs.len[l] + dc;
        const j = i + l;
        if (c < cost[j]) {
          cost[j] = c;
          from[j] = i;
          mLen[j] = l;
          mDist[j] = m.dist[i];
        }
      }
    }
  }
  let count = 0;
  for (let p = n; p > 0; p = from[p]) count++;
  const kind = new Uint8Array(count);
  const a = new Int32Array(count);
  const b = new Int32Array(count);
  let idx = count;
  for (let p = n; p > 0; ) {
    const f = from[p];
    idx--;
    if (mLen[p] === 0) {
      kind[idx] = 0;
      a[idx] = data[f];
    } else {
      kind[idx] = 1;
      a[idx] = mLen[p];
      b[idx] = mDist[p];
    }
    p = f;
  }
  return { kind, a, b, count };
}

function frequenciesOf(s: Symbols): { lit: Uint32Array; dist: Uint32Array } {
  const lit = new Uint32Array(286);
  const dist = new Uint32Array(30);
  for (let i = 0; i < s.count; i++) {
    if (s.kind[i] === 0) lit[s.a[i]]++;
    else {
      lit[LEN_SYM[s.a[i]]]++;
      dist[DIST_SYM[s.b[i]]]++;
    }
  }
  lit[256]++;
  return { lit, dist };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** RLE-encode code lengths the way a dynamic block header does; returns pairs and CL frequencies. */
function rleLengths(lens: ArrayLike<number>): { pairs: Array<[number, number]>; freq: Uint32Array } {
  const pairs: Array<[number, number]> = [];
  const freq = new Uint32Array(19);
  let i = 0;
  while (i < lens.length) {
    const v = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        pairs.push([18, take - 11]);
        freq[18]++;
        r -= take;
      }
      if (r >= 3) {
        pairs.push([17, r - 3]);
        freq[17]++;
        r = 0;
      }
      while (r > 0) {
        pairs.push([0, 0]);
        freq[0]++;
        r--;
      }
    } else {
      pairs.push([v, 0]);
      freq[v]++;
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        pairs.push([16, take - 3]);
        freq[16]++;
        r -= take;
      }
      while (r > 0) {
        pairs.push([v, 0]);
        freq[v]++;
        r--;
      }
    }
    i += run;
  }
  return { pairs, freq };
}

interface BlockTables {
  litLens: Uint8Array;
  distLens: Uint8Array;
  litCodes: Int32Array;
  distCodes: Int32Array;
  tableBits: number;
  rle: Array<[number, number]>;
  clLens: Uint8Array;
  clCodes: Int32Array;
  hlit: number;
  hdist: number;
  hclen: number;
}

/** Dynamic tables for one block's symbols, with the header's exact bit cost. */
function blockTables(s: Symbols, s0: number, s1: number): BlockTables {
  const fl = new Uint32Array(286);
  const fd = new Uint32Array(30);
  for (let i = s0; i < s1; i++) {
    if (s.kind[i] === 0) fl[s.a[i]]++;
    else {
      fl[LEN_SYM[s.a[i]]]++;
      fd[DIST_SYM[s.b[i]]]++;
    }
  }
  fl[256]++;
  let litLens = huffmanLengths(fl, 15);
  let distLens = huffmanLengths(fd, 15);
  let allZero = true;
  for (let i = 0; i < 30; i++) if (distLens[i] !== 0) allZero = false;
  if (allZero) distLens[0] = 1;
  let hlit = 286;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const allLens = new Uint8Array(hlit + hdist);
  allLens.set(litLens.subarray(0, hlit), 0);
  allLens.set(distLens.subarray(0, hdist), hlit);
  const { pairs, freq } = rleLengths(allLens);
  // A code-length Huffman code needs at least two symbols; add a dummy if needed.
  let nonzero = 0;
  let only = -1;
  for (let i = 0; i < 19; i++) if (freq[i] > 0) { nonzero++; only = i; }
  if (nonzero < 2) {
    freq[only === 0 ? 1 : 0] = 1;
  }
  const clLens = huffmanLengths(freq, 7);
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  let tableBits = 14 + 3 * hclen;
  for (const [sym, extra] of pairs) {
    tableBits += clLens[sym];
    if (sym === 16) tableBits += 2;
    else if (sym === 17) tableBits += 3;
    else if (sym === 18) tableBits += 7;
  }
  const litC = canonicalCodes(litLens);
  const distC = canonicalCodes(distLens);
  const clC = canonicalCodes(clLens);
  return {
    litLens,
    distLens,
    litCodes: litC.codes,
    distCodes: distC.codes,
    tableBits,
    rle: pairs,
    clLens,
    clCodes: clC.codes,
    hlit,
    hdist,
    hclen,
  };
}

const FIXED_CODES = canonicalCodes(FIXED_LIT_LEN);
const BLOCK_BYTES = 100000;

/** Emit the symbol sequence as DEFLATE blocks (dynamic when it pays, fixed otherwise). */
function emitBlocks(w: BitWriter, s: Symbols): void {
  let s0 = 0;
  let inputLen = 0;
  for (let i = 0; i <= s.count; i++) {
    const boundary = i === s.count || inputLen >= BLOCK_BYTES;
    if (!boundary) {
      inputLen += s.kind[i] === 0 ? 1 : s.a[i];
      continue;
    }
    const last = i === s.count;
    const t = blockTables(s, s0, i);
    // Data bits under dynamic vs fixed tables.
    let dynBits = t.tableBits;
    let fixBits = 0;
    for (let j = s0; j < i; j++) {
      if (s.kind[j] === 0) {
        dynBits += t.litLens[s.a[j]];
        fixBits += FIXED_LIT_LEN[s.a[j]];
      } else {
        const ls = LEN_SYM[s.a[j]];
        const ds = DIST_SYM[s.b[j]];
        dynBits += t.litLens[ls] + LEN_EXT[s.a[j]] + t.distLens[ds] + DIST_EXT[s.b[j]];
        fixBits += FIXED_LIT_LEN[ls] + LEN_EXT[s.a[j]] + 5 + DIST_EXT[s.b[j]];
      }
    }
    dynBits += t.litLens[256];
    fixBits += FIXED_LIT_LEN[256];
    if (dynBits < fixBits) {
      w.write(last ? 1 : 0, 1);
      w.write(2, 2);
      w.write(t.hlit - 257, 5);
      w.write(t.hdist - 1, 5);
      w.write(t.hclen - 4, 4);
      for (let k = 0; k < t.hclen; k++) w.write(t.clLens[CL_ORDER[k]], 3);
      for (const [sym, extra] of t.rle) {
        w.writeCode(t.clCodes[sym], t.clLens[sym]);
        if (sym === 16) w.write(extra, 2);
        else if (sym === 17) w.write(extra, 3);
        else if (sym === 18) w.write(extra, 7);
      }
      for (let j = s0; j < i; j++) {
        if (s.kind[j] === 0) w.writeCode(t.litCodes[s.a[j]], t.litLens[s.a[j]]);
        else {
          const ls = LEN_SYM[s.a[j]];
          const ds = DIST_SYM[s.b[j]];
          w.writeCode(t.litCodes[ls], t.litLens[ls]);
          w.write(s.a[j] - LEN_BASE[ls - 257], LEN_EXT[s.a[j]]);
          w.writeCode(t.distCodes[ds], t.distLens[ds]);
          w.write(s.b[j] - DIST_BASE[ds], DIST_EXT[s.b[j]]);
        }
      }
      w.writeCode(t.litCodes[256], t.litLens[256]);
    } else {
      w.write(last ? 1 : 0, 1);
      w.write(1, 2);
      for (let j = s0; j < i; j++) {
        if (s.kind[j] === 0) w.writeCode(FIXED_CODES.codes[s.a[j]], FIXED_CODES.lens[s.a[j]]);
        else {
          const ls = LEN_SYM[s.a[j]];
          const ds = DIST_SYM[s.b[j]];
          w.writeCode(FIXED_CODES.codes[ls], FIXED_CODES.lens[ls]);
          w.write(s.a[j] - LEN_BASE[ls - 257], LEN_EXT[s.a[j]]);
          w.writeCode(ds, 5);
          w.write(s.b[j] - DIST_BASE[ds], DIST_EXT[s.b[j]]);
        }
      }
      w.writeCode(FIXED_CODES.codes[256], FIXED_CODES.lens[256]);
    }
    s0 = i;
    inputLen = 0;
  }
}

/** A zlib stream of `data` by optimal-parse DEFLATE (two DP passes: fixed, then dynamic costs). */
function deflateOptimal(data: Uint8Array): Uint8Array {
  const n = data.length;
  if (n === 0) return Uint8Array.of(0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01);
  const m = findMatches(data);
  const s1 = optimalParse(data, fixedCosts(), m);
  const f = frequenciesOf(s1);
  const s2 = optimalParse(data, dynamicCosts(f.lit, f.dist), m);
  const w = new BitWriter(n + 1024);
  emitBlocks(w, s2);
  const deflate = w.finish();
  const out = new Uint8Array(2 + deflate.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(deflate, 2);
  new DataView(out.buffer).setUint32(2 + deflate.length, adler32(data));
  return out;
}

function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const { form, data } = screen(rgba, width, height);
  // Final pass: zlib level 9, three settings, smallest stream wins.
  let best: Uint8Array | null = null;
  for (const opts of [
    { level: 9, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 9, strategy: zlibConstants.Z_FILTERED },
    { level: 9, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY },
  ]) {
    const z = deflateSync(data, opts);
    if (best === null || z.length < best.length) best = z;
  }
  // Optimal-parse DEFLATE: kept only when it is smaller and inflates back to
  // exactly the filtered data (any failure keeps zlib's stream).
  try {
    const opt = deflateOptimal(data);
    if (opt.length < (best as Uint8Array).length) {
      const back = inflateSync(opt);
      if (back.length === data.length && Buffer.compare(back, Buffer.from(data)) === 0) best = opt;
    }
  } catch {
    // fall through with zlib's stream
  }
  return pngOfForm(width, height, form, best as Uint8Array);
}

/* ---------------- Entry point ---------------- */

for (const id of readdirSync(INPUT_DIR).sort()) {
  const { rgba, width, height } = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), squeeze(rgba, width, height));
}
