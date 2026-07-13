/**
 * Binary Delphi form stream (TPF0) → text-DFM converter.
 *
 * Delphi ≤4 saved forms in the binary TWriter object-stream format (and later
 * versions can too, via "Text DFM" unchecked). The stream is well specified by
 * Classes.pas: a `TPF0` signature followed by a recursive object frame
 *
 *   [flag prefix?] <classname> <objectname> { <prop> <typed value> } 0
 *   { <child object> } 0
 *
 * with byte-length-prefixed names and a TValueType tag before every value.
 * Rather than duplicating the extraction logic, we convert the stream into
 * the equivalent *text* DFM (`object Name: TClass` / `Prop = value` / `end`)
 * and feed it through the existing text parser — captions, event wirings and
 * data links then flow through the exact same code path.
 *
 * The input string must be read with latin1 so `charCodeAt(i)` is byte `i`
 * (see `sourceEncoding` on the dfm plugin meta).
 *
 * On-disk files usually wrap the stream in a tiny 16-bit resource header
 * (FF 0A 00 <NAME> 00 <size>), so we locate the signature by scanning the
 * first bytes instead of assuming offset 0.
 */

/** TValueType, Classes.pas order — stable since Delphi 2 for these members. */
const Va = {
  Null: 0, List: 1, Int8: 2, Int16: 3, Int32: 4, Extended: 5,
  String: 6, Ident: 7, False: 8, True: 9, Binary: 10, Set: 11,
  LString: 12, Nil: 13, Collection: 14, Single: 15, Currency: 16,
  Date: 17, WString: 18, Int64: 19, UTF8String: 20, Double: 21,
} as const;

const SIGNATURE = "TPF0";
/** How deep into the file the signature may sit (resource wrapper is ~20 B). */
const SIGNATURE_WINDOW = 256;

/** True when the source looks like a binary form stream (vs text DFM). */
export function isBinaryDfm(source: string): boolean {
  if (source.length === 0) return false;
  // Text DFMs start with "object"/"inherited"/"inline" (maybe after a BOM);
  // binary ones start with 0xFF (resource wrapper) or the raw signature.
  const head = source.slice(0, SIGNATURE_WINDOW);
  return head.includes(SIGNATURE) &&
    (source.charCodeAt(0) === 0xff || head.startsWith(SIGNATURE));
}

class StreamError extends Error {}

class Reader {
  pos = 0;
  private readonly s: string;
  constructor(s: string) { this.s = s; }

  get eof(): boolean { return this.pos >= this.s.length; }

  peek(): number {
    if (this.eof) throw new StreamError("eof");
    return this.s.charCodeAt(this.pos);
  }

  byte(): number {
    const b = this.peek();
    this.pos++;
    return b;
  }

  /** n raw bytes as a latin1 substring. */
  raw(n: number): string {
    if (this.pos + n > this.s.length) throw new StreamError("eof");
    const out = this.s.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  bytes(n: number): Uint8Array {
    const str = this.raw(n);
    const arr = new Uint8Array(n);
    for (let i = 0; i < n; i++) arr[i] = str.charCodeAt(i);
    return arr;
  }

  /** Byte-length-prefixed name (classname, object name, property name). */
  shortStr(): string {
    return this.raw(this.byte());
  }

  int(n: 2 | 4): number {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.byte() << (8 * i);
    // Sign-extend.
    return n === 2 ? (v << 16) >> 16 : v | 0;
  }

  u32(): number {
    return (this.byte() | (this.byte() << 8) | (this.byte() << 16)) + this.byte() * 0x1000000;
  }
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function utf16le(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  }
  return out;
}

function float64(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
}

/** 80-bit x87 extended → number (sign, 15-bit exponent, explicit-1 mantissa). */
function extended(bytes: Uint8Array): number {
  const sign = bytes[9]! & 0x80 ? -1 : 1;
  const exp = ((bytes[9]! & 0x7f) << 8) | bytes[8]!;
  let mantissa = 0;
  for (let i = 7; i >= 0; i--) mantissa = mantissa * 256 + bytes[i]!;
  if (exp === 0 && mantissa === 0) return 0;
  return sign * mantissa * Math.pow(2, exp - 16383 - 63);
}

/** Delphi-quote a string for the emitted text DFM ('' escapes a quote). */
function quote(s: string): string {
  // Captions are single-line values in the text format; fold hard breaks.
  return "'" + s.replace(/'/g, "''").replace(/\r?\n/g, " ") + "'";
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

/** Read one typed value and return its text-DFM representation. */
function readValue(r: Reader): string {
  const tag = r.byte();
  switch (tag) {
    case Va.Null: return "Null";
    case Va.List: {
      const items: string[] = [];
      while (r.peek() !== Va.Null) items.push(readValue(r));
      r.byte(); // list end
      return `(${items.join(" ")})`;
    }
    case Va.Int8: return String((r.byte() << 24) >> 24);
    case Va.Int16: return String(r.int(2));
    case Va.Int32: return String(r.int(4));
    case Va.Extended: return fmtNum(extended(r.bytes(10)));
    case Va.String: return quote(r.shortStr());
    case Va.Ident: return r.shortStr();
    case Va.False: return "False";
    case Va.True: return "True";
    case Va.Binary: {
      r.bytes(r.u32());
      return "{binary}";
    }
    case Va.Set: {
      const idents: string[] = [];
      for (;;) {
        const ident = r.shortStr();
        if (ident.length === 0) break;
        idents.push(ident);
      }
      return `[${idents.join(", ")}]`;
    }
    case Va.LString: return quote(r.raw(r.u32()));
    case Va.Nil: return "nil";
    case Va.Collection: {
      // Items: [optional integer order] vaList of name/value pairs.
      while (r.peek() !== Va.Null) {
        if (r.peek() === Va.Int8 || r.peek() === Va.Int16 || r.peek() === Va.Int32) {
          readValue(r);
        }
        if (r.byte() !== Va.List) throw new StreamError("collection item");
        while (r.peek() !== Va.Null) {
          r.shortStr();  // property name
          readValue(r);  // property value
        }
        r.byte(); // item list end
      }
      r.byte(); // collection end
      return "<>";
    }
    case Va.Single: {
      const b = r.bytes(4);
      return fmtNum(new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true));
    }
    case Va.Currency: {
      const b = r.bytes(8);
      return fmtNum(float64frombits(b) /* int64 scaled by 1e4 */);
    }
    case Va.Date: return fmtNum(float64(r.bytes(8)));
    case Va.WString: return quote(utf16le(r.bytes(r.u32() * 2)));
    case Va.Int64: {
      const lo = r.u32();
      const hi = r.int(4);
      return String(hi * 0x100000000 + lo);
    }
    case Va.UTF8String: return quote(utf8(r.bytes(r.u32())));
    case Va.Double: return fmtNum(float64(r.bytes(8)));
    default:
      throw new StreamError(`value tag ${tag}`);
  }
}

/** Currency is a little-endian int64 scaled by 10000. */
function float64frombits(b: Uint8Array): number {
  let lo = 0;
  for (let i = 3; i >= 0; i--) lo = lo * 256 + b[i]!;
  let hi = 0;
  for (let i = 7; i >= 4; i--) hi = hi * 256 + b[i]!;
  if (b[7]! & 0x80) hi -= 0x100000000; // crude sign handling; magnitudes are tiny in DFMs
  return (hi * 0x100000000 + lo) / 10000;
}

/** TFilerFlag bits in the 0xF0 object prefix (Delphi 5+). */
const FF_CHILDPOS = 2;

function readObject(r: Reader, indent: number, out: string[]): void {
  let keyword = "object";
  if (r.peek() >= 0xf0) {
    const flags = r.byte() & 0x0f;
    if (flags & 1) keyword = "inherited";
    if (flags & 4) keyword = "inline";
    if (flags & FF_CHILDPOS) readValue(r); // child position integer
  }
  const className = r.shortStr();
  const objName = r.shortStr();
  const pad = "  ".repeat(indent);
  out.push(
    objName.length > 0
      ? `${pad}${keyword} ${objName}: ${className}`
      : `${pad}${keyword} ${className}`,
  );

  while (r.peek() !== 0) {
    const prop = r.shortStr();
    if (prop.length === 0) break;
    const value = readValue(r);
    out.push(`${pad}  ${prop} = ${value}`);
  }
  r.byte(); // property terminator

  while (r.peek() !== 0) {
    readObject(r, indent + 1, out);
  }
  r.byte(); // children terminator

  out.push(`${pad}end`);
}

/**
 * Convert a binary DFM (latin1-read) to its text-DFM equivalent, or null when
 * the signature is missing or the stream is structurally broken before the
 * root object completes. Line numbers in the result are synthetic but
 * self-consistent — every downstream consumer only needs them for ordering.
 */
export function binaryDfmToText(source: string): string | null {
  const sigAt = source.slice(0, SIGNATURE_WINDOW).indexOf(SIGNATURE);
  if (sigAt < 0) return null;
  const r = new Reader(source);
  r.pos = sigAt + SIGNATURE.length;
  const out: string[] = [];
  try {
    readObject(r, 0, out);
  } catch (e) {
    if (!(e instanceof StreamError)) throw e;
    // Salvage a truncated stream: close every open object so the text parser
    // still sees the components read so far.
    if (out.length === 0) return null;
    let depth = 0;
    for (const line of out) {
      if (/^\s*(object|inherited|inline)\b/.test(line)) depth++;
      else if (/^\s*end$/.test(line)) depth--;
    }
    for (let i = depth; i > 0; i--) out.push("  ".repeat(i - 1) + "end");
  }
  return out.join("\n");
}
