/**
 * What a file's own `#define`s stand for, read off the directive text (no preprocessor run): a macro whose body
 * opens a block, closes one, is a cast, is a compound statement, or pastes a name with `##`. A name defined twice
 * with different bodies is dropped. The reader rewrites a use only after the file as written failed to parse, and
 * only where that shape can stand, so a file that parsed is unchanged.
 *
 * A quoted `#include` of a relative path (no `..`) is read the same way when the caller passes the file's path:
 * the header's shapes fill in names the file itself does not define. `-I` directories are not searched.
 */
import { readFileSync } from "fs";
import { dirname, join, normalize, sep } from "path";
import { conditionalBlocks } from "../shared/preprocessor-branches.js";
import { codeMask } from "../shared/code-mask.js";

export type DefineKind = "opens" | "closes" | "cast" | "body" | "paste";

export interface DefineShape {
  kind: DefineKind;
  /** Present for a function-like macro. */
  params?: string[];
  /** The cast, the compound statement, `{`, `}`, or the paste body. */
  text: string;
  /** A wrapper (`JOIN(a, b) JOIN2(a, b)`) expands arguments before the paste; a direct `a##b` does not. */
  expandArgs?: boolean;
}

export interface DefineFacts {
  shapes: Map<string, DefineShape>;
  /** Object-like macros whose body is one token, for expanding a paste's arguments. */
  values: Map<string, string>;
  /** Defined twice with different bodies: neither the file nor a header may supply it. */
  blocked: Set<string>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/;
/** A parameter, not a macro argument: `CLUB_JOIN(int n)` is a function, not a paste. */
const TYPE_WORD = new Set(["int", "void", "char", "long", "short", "float", "double", "unsigned", "signed", "struct", "union", "enum", "const", "static", "size_t", "restrict"]);

const emptyFacts = (): DefineFacts => ({ shapes: new Map(), values: new Map(), blocked: new Set() });

interface RawDef {
  params?: string[];
  body: string;
}

function deadLines(lines: readonly string[]): Set<number> {
  const dead = new Set<number>();
  for (const block of conditionalBlocks(lines, false)) {
    for (let i = block.start + 1; i < block.end; i++) if (!block.arms.some(([a, b]) => i >= a && i <= b)) dead.add(i);
  }
  return dead;
}

function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

function braceDelta(body: string): number {
  const t = body.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
  let d = 0;
  for (const c of t) {
    if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d;
}

function classify(body: string): { kind: DefineKind; text: string } | null {
  if (!body) return null;
  // A `#` that is not a paste (`#arg`, a stringized argument) builds text, not one of these shapes.
  if (body.replace(/##/g, "").includes("#")) return null;
  if (body.includes("##")) return { kind: "paste", text: body };
  const delta = braceDelta(body);
  if (body.startsWith("{") && delta === 0) return { kind: "body", text: body.replace(/\s+/g, " ") };
  if (delta > 0 && body.endsWith("{")) return { kind: "opens", text: "{" };
  if (body === "}" || (delta < 0 && body.endsWith("}"))) return { kind: "closes", text: "}" };
  if (/^\([^()]+\)$/.test(body)) return { kind: "cast", text: body };
  return null;
}

function collectRaw(text: string): Map<string, RawDef | "conflict"> {
  const lines = text.split("\n");
  const dead = deadLines(lines);
  const out = new Map<string, RawDef | "conflict">();
  for (let i = 0; i < lines.length; i++) {
    if (dead.has(i) || !/^\s*#\s*define\b/.test(lines[i]!)) continue;
    let joined = "";
    for (; i < lines.length; i++) {
      const cont = /\\$/.test(lines[i]!.trimEnd());
      joined += (joined ? " " : "") + lines[i]!.replace(/\\\s*$/, " ");
      if (!cont) break;
    }
    const m = /^\s*#\s*define\s+([A-Za-z_]\w*)(?:\(([^)]*)\))?\s*([\s\S]*)$/.exec(joined);
    if (!m) continue;
    const params = m[2] !== undefined ? m[2].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const def: RawDef = { params, body: stripComments(m[3] ?? "").trim() };
    const prev = out.get(m[1]!);
    const same = prev && prev !== "conflict" && prev.body === def.body && (prev.params ?? []).join(",") === (def.params ?? []).join(",");
    if (prev && !same) out.set(m[1]!, "conflict");
    else if (!prev) out.set(m[1]!, def);
  }
  return out;
}

function resolveShape(name: string, raw: Map<string, RawDef | "conflict">, seen: string[]): DefineShape | null {
  if (seen.includes(name) || seen.length > 4) return null;
  const def = raw.get(name);
  if (!def || def === "conflict") return null;
  const direct = classify(def.body);
  if (direct) return { ...direct, params: def.params, ...(direct.kind === "paste" ? { expandArgs: false } : {}) };
  const call = /^([A-Za-z_]\w*)\s*\(\s*([^)]*)\s*\)$/.exec(def.body);
  if (!call) return null;
  const inner = resolveShape(call[1]!, raw, [...seen, name]);
  if (!inner) return null;
  if (inner.kind === "paste") {
    const args = call[2]!.split(",").map((s) => s.trim());
    const params = def.params ?? [];
    if (args.length !== params.length || args.some((a, i) => a !== params[i])) return null;
    return { ...inner, params, expandArgs: true };
  }
  return { ...inner, params: def.params };
}

/** The shapes and one-token values of `text`. */
export function defineFacts(text: string): DefineFacts {
  const facts = emptyFacts();
  if (!text.includes("#define")) return facts;
  const raw = collectRaw(text);
  for (const [name, def] of raw) {
    if (def === "conflict") {
      facts.blocked.add(name);
      continue;
    }
    const shape = resolveShape(name, raw, []);
    if (shape) facts.shapes.set(name, shape);
    if (!def.params && TOKEN.test(def.body)) facts.values.set(name, def.body);
  }
  return facts;
}

function headerPath(fromFile: string, include: string): string | null {
  if (!include || include.startsWith("/") || include.includes("\\") || include.split("/").includes("..")) return null;
  const dir = dirname(fromFile);
  const full = normalize(join(dir, include));
  if (full !== dir && !full.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return null;
  return full;
}

const headerCache = new Map<string, DefineFacts>();
const MAX_HEADERS = 8;
const MAX_HEADER_CHARS = 256 * 1024;

function factsOfHeader(path: string, seen: Set<string>, left: { n: number }): DefineFacts {
  const cached = headerCache.get(path);
  if (cached) return cached;
  if (seen.has(path) || left.n <= 0) return emptyFacts();
  seen.add(path);
  left.n--;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    headerCache.set(path, emptyFacts());
    return emptyFacts();
  }
  if (text.length > MAX_HEADER_CHARS) text = text.slice(0, MAX_HEADER_CHARS);
  const facts = defineFacts(text);
  for (const inc of text.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
    const next = headerPath(path, inc[1]!);
    if (!next) continue;
    const inner = factsOfHeader(next, seen, left);
    for (const [name, shape] of inner.shapes) if (!facts.shapes.has(name) && !facts.blocked.has(name)) facts.shapes.set(name, shape);
    for (const [name, value] of inner.values) if (!facts.values.has(name)) facts.values.set(name, value);
    for (const name of inner.blocked) facts.blocked.add(name);
  }
  headerCache.set(path, facts);
  return facts;
}

/**
 * Shapes from the quoted headers `text` includes, relative to `absolutePath`'s directory, one step of their own
 * includes too. Names the file itself defines are not here.
 */
export function includeFacts(text: string, absolutePath: string): DefineFacts {
  const facts = emptyFacts();
  if (!text.includes("#include") || !absolutePath) return facts;
  const seen = new Set<string>();
  const left = { n: MAX_HEADERS };
  for (const inc of text.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
    const path = headerPath(absolutePath, inc[1]!);
    if (!path) continue;
    const inner = factsOfHeader(path, seen, left);
    for (const [name, shape] of inner.shapes) if (!facts.blocked.has(name)) facts.shapes.set(name, shape);
    for (const [name, value] of inner.values) facts.values.set(name, value);
    for (const name of inner.blocked) {
      facts.blocked.add(name);
      facts.shapes.delete(name);
    }
  }
  return facts;
}

/** File shapes win; a name the file defines twice stays blocked. */
export function mergeFacts(file: DefineFacts, headers: DefineFacts): DefineFacts {
  const shapes = new Map(headers.shapes);
  for (const name of file.blocked) shapes.delete(name);
  for (const name of headers.blocked) shapes.delete(name);
  for (const [name, shape] of file.shapes) shapes.set(name, shape);
  const values = new Map(headers.values);
  for (const [name, value] of file.values) values.set(name, value);
  const blocked = new Set([...file.blocked, ...headers.blocked]);
  for (const name of blocked) shapes.delete(name);
  return { shapes, values, blocked };
}

function nextSignificant(text: string, mask: Uint8Array, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (!mask[i]) continue;
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") continue;
    return i;
  }
  return text.length;
}

function prevSignificant(text: string, mask: Uint8Array, from: number): string {
  for (let i = from - 1; i >= 0; i--) {
    if (!mask[i]) continue;
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") continue;
    return c;
  }
  return "";
}

function callEnd(text: string, mask: Uint8Array, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (!mask[i]) continue;
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * `text` with the uses a shape can stand in rewritten to that shape, columns kept where the replacement fits in the
 * use. A use the shape does not match is left, and so is a paste (the function is renamed after the parse).
 */
export function rewriteDefineShapes(text: string, facts: DefineFacts): string {
  if (facts.shapes.size === 0) return text;
  const mask = codeMask(text);
  const spans: Array<{ start: number; end: number; rep: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (!mask[i] || !/[A-Za-z_]/.test(text[i]!)) continue;
    let j = i + 1;
    while (j < text.length && mask[j] && /[A-Za-z0-9_]/.test(text[j]!)) j++;
    const shape = facts.shapes.get(text.slice(i, j));
    if (!shape || shape.kind === "paste") {
      i = j - 1;
      continue;
    }
    const next = nextSignificant(text, mask, j);
    const open = next < text.length && text[next] === "(" ? next : -1;
    const end = shape.params ? (open < 0 ? -1 : callEnd(text, mask, open)) : open >= 0 ? -1 : j;
    if (end < 0) {
      i = j - 1;
      continue;
    }
    const after = nextSignificant(text, mask, end);
    const afterChar = after < text.length ? text[after]! : "";
    let take = false;
    if (shape.kind === "opens") take = afterChar !== ";" && afterChar !== "{";
    else if (shape.kind === "closes") take = afterChar !== "(";
    else if (shape.kind === "body") take = prevSignificant(text, mask, i) === ")" && afterChar !== "{";
    else take = afterChar === "{";
    if (take) spans.push({ start: i, end, rep: shape.text.length >= end - i ? shape.text : shape.text + " ".repeat(end - i - shape.text.length) });
    i = Math.max(j, end) - 1;
  }
  if (spans.length === 0) return text;
  let out = text;
  for (const s of spans.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.rep + out.slice(s.end);
  return out;
}

function applyPaste(body: string, params: readonly string[], args: readonly string[]): string | null {
  let out = "";
  for (const part of body.split("##")) {
    const piece = part.trim();
    if (!piece) return null;
    const at = params.indexOf(piece);
    out += at >= 0 ? args[at]! : piece;
  }
  return out;
}

/**
 * The name `name` at `line` builds when it is a paste macro and the arguments after it are tokens, not a parameter
 * list. Null when it is not that shape.
 */
export function pastedFunctionName(text: string, line: number, name: string, facts: DefineFacts): string | null {
  const shape = facts.shapes.get(name);
  if (!shape || shape.kind !== "paste" || !shape.params?.length || facts.blocked.has(name)) return null;
  const lines = text.split("\n");
  const window = `${lines[line - 1] ?? ""} ${lines[line] ?? ""}`;
  const at = window.indexOf(name);
  if (at < 0) return null;
  const args = /^\s*\(([^)]*)\)/.exec(window.slice(at + name.length))?.[1]?.split(",").map((s) => s.trim()) ?? null;
  if (!args || args.length !== shape.params.length) return null;
  if (args.some((a) => TYPE_WORD.has(a))) return null;
  const expanded = args.map((a) => {
    if (shape.expandArgs !== true) return a;
    const value = facts.values.get(a);
    return value && TOKEN.test(value) ? value : a;
  });
  if (expanded.some((a) => !TOKEN.test(a))) return null;
  const built = applyPaste(shape.text, shape.params, expanded);
  return built && IDENT.test(built) && built !== name ? built : null;
}

/**
 * The format macros a refused file says exactly one of (`defined(A) + defined(B) != 1` and then `#error`), in the
 * order written. Null when the file does not say that.
 */
export function exclusiveFormats(text: string): string[] | null {
  const m = /#\s*if\s+((?:defined\s*\(\s*[A-Za-z_]\w*\s*\)\s*\+\s*)+defined\s*\(\s*[A-Za-z_]\w*\s*\))\s*!=\s*1/.exec(text);
  if (!m || !/#\s*error\b/.test(text.slice(m.index, m.index + 400))) return null;
  const names = [...m[1]!.matchAll(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g)].map((x) => x[1]!);
  return names.length >= 2 ? names : null;
}
