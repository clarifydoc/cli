/**
 * An installed npm package's exported API, read from what it ships: its type
 * declarations (`types` / `typings`, the `exports` map's `types` condition,
 * `index.d.ts`, the `@types/` package), else its entry module's exports. So an
 * agent calls the API of the version in `node_modules`, not of the one it
 * remembers. On demand only (the MCP server asks); analysis never walks
 * `node_modules`.
 */

import { readFile, stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import type { InstalledPackageApi } from "../../../types/language-plugin.js";

const NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const MAX_FILES = 25;
const MAX_EXPORTS = 400;
const DTS = [".d.ts", ".d.mts", ".d.cts"];

type Export = InstalledPackageApi["exports"][number];

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isFile = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/** The `types` condition of an `exports` entry, however deeply it is nested. */
function typesCondition(entry: unknown, depth = 0): string | undefined {
  if (depth > 4 || !entry) return undefined;
  if (typeof entry === "string") return DTS.some((e) => entry.endsWith(e)) ? entry : undefined;
  if (Array.isArray(entry)) {
    for (const e of entry) {
      const t = typesCondition(e, depth + 1);
      if (t) return t;
    }
    return undefined;
  }
  if (typeof entry !== "object") return undefined;
  const o = entry as Record<string, unknown>;
  if (typeof o.types === "string") return o.types;
  for (const key of ["import", "require", "node", "default"]) {
    const t = typesCondition(o[key], depth + 1);
    if (t) return t;
  }
  return undefined;
}

/** The module files an `exports` entry names (`import`, `require`, `default` conditions), in that order. */
function jsEntries(entry: unknown, depth = 0): string[] {
  if (depth > 4 || !entry) return [];
  if (typeof entry === "string") return /\.[cm]?js$/.test(entry) ? [entry] : [];
  if (Array.isArray(entry)) return entry.flatMap((e) => jsEntries(e, depth + 1));
  if (typeof entry !== "object") return [];
  const o = entry as Record<string, unknown>;
  return ["import", "require", "node", "default"].flatMap((k) => jsEntries(o[k], depth + 1));
}

/** The declaration file a package's root import resolves to, or its JS entry when it ships none. */
async function entryOf(dir: string, pkg: Record<string, unknown>): Promise<{ file: string; typed: boolean } | null> {
  const exp = pkg.exports;
  const root = exp && typeof exp === "object" && !Array.isArray(exp) && "." in (exp as object) ? (exp as Record<string, unknown>)["."] : exp;
  const js = jsEntries(root);
  const dtsOf = (f: string) => {
    const stem = f.replace(/\.([cm]?)js$/, "");
    const m = /\.([cm]?)js$/.exec(f)?.[1] ?? "";
    return [`${stem}.d.${m}ts`, `${stem}.d.ts`];
  };
  const candidates = [
    typeof pkg.types === "string" ? pkg.types : undefined,
    typeof pkg.typings === "string" ? pkg.typings : undefined,
    typesCondition(root),
    ...js.flatMap(dtsOf),
    "index.d.ts",
    ...(typeof pkg.main === "string" ? dtsOf(pkg.main) : []),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const f = resolve(dir, c);
    if (!f.startsWith(dir)) continue;
    if (await isFile(f)) return { file: f, typed: true };
    if (!DTS.some((e) => f.endsWith(e)) && (await isFile(join(f, "index.d.ts")))) return { file: join(f, "index.d.ts"), typed: true };
  }
  const main = js[0] ?? (typeof pkg.module === "string" ? pkg.module : typeof pkg.main === "string" ? pkg.main : "index.js");
  for (const f of [resolve(dir, main), resolve(dir, `${main}.js`), join(resolve(dir, main), "index.js")]) {
    if (f.startsWith(dir) && (await isFile(f))) return { file: f, typed: false };
  }
  return null;
}

/** `./x` from a declaration file → the declaration file it names. */
async function resolveDts(from: string, spec: string): Promise<string | null> {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec.replace(/\.[cm]?js$/, ""));
  for (const f of [...DTS.map((e) => base + e), ...DTS.map((e) => join(base, `index${e}`)), base]) {
    if ((DTS.some((e) => f.endsWith(e)) || f.endsWith(".ts")) && (await isFile(f))) return f;
  }
  return null;
}

/** A declaration starting at `i`, joined to one line until it closes (`;`, `{`), cut to 200 characters. */
function signatureAt(lines: string[], i: number): string {
  let text = lines[i]!.trim();
  for (let j = i + 1; j < Math.min(lines.length, i + 6) && !/[;{]\s*$/.test(text) && !/=>\s*\S/.test(text); j++) text += ` ${lines[j]!.trim()}`;
  text = text.replace(/\s*\{\s*$/, "").replace(/;\s*$/, "").replace(/\s+/g, " ");
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

const DECL = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(async\s+function|function\*?|const|let|var|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const KIND: Record<string, string> = { "async function": "function", "function*": "function", let: "const", var: "const", module: "namespace" };

const MEMBER = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const AMBIENT = /^declare\s+module\s+["'][^"']+["']\s*\{\s*$/;

/**
 * The exports a declaration file states, following `export * from` into the
 * package's own files. An ambient `declare module "x" { … }` is read as the
 * file itself; `export = X` lists X's own declaration and, for a namespace,
 * its members.
 */
async function readDeclarations(entry: string, out: Export[], seen: Set<string>, depth = 0): Promise<boolean> {
  if (seen.has(entry) || seen.size >= MAX_FILES || depth > 4) return seen.size >= MAX_FILES;
  seen.add(entry);
  const text = await readFile(entry, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/);
  let truncated = false;
  let braces = 0;
  let base = 0;
  const assigned: string[] = [];
  /** Depth before each line, for the `export =` pass. */
  const depthAt: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    depthAt.push(braces);
    const top = braces === base;
    const t = line.trim();
    braces += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (braces < base) base = braces = Math.max(0, braces);
    if (!top || out.length >= MAX_EXPORTS) continue;
    if (base === 0 && AMBIENT.test(t)) {
      base = 1;
      continue;
    }
    const d = DECL.exec(t);
    if (d) {
      out.push({ name: /^export\s+(?:declare\s+)?default\b/.test(t) ? "default" : d[2]!, kind: KIND[d[1]!] ?? d[1]!, signature: signatureAt(lines, i), file: entry, line: i + 1 });
      continue;
    }
    if (/^export\s+default\b/.test(t)) {
      out.push({ name: "default", kind: "default", signature: signatureAt(lines, i), file: entry, line: i + 1 });
      continue;
    }
    const star = /^export\s+\*\s+(?:as\s+([\w$]+)\s+)?from\s+["']([^"']+)["']/.exec(t);
    if (star) {
      if (star[1]) out.push({ name: star[1], kind: "namespace", signature: t.replace(/;$/, ""), file: entry, line: i + 1 });
      else {
        const next = await resolveDts(entry, star[2]!);
        if (next) truncated = (await readDeclarations(next, out, seen, depth + 1)) || truncated;
      }
      continue;
    }
    const named = /^export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*(["'][^"']+["']))?/.exec(t);
    if (named) {
      for (const part of named[2]!.split(",")) {
        const m = /^\s*(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
        if (!m || out.length >= MAX_EXPORTS) continue;
        // One row per name, spelled as its own re-export so its declaration can be found again.
        const signature = `export { ${m[2]}${m[3] ? ` as ${m[3]}` : ""} }${named[3] ? ` from ${named[3]}` : ""}`;
        out.push({ name: m[3] ?? m[2]!, kind: named[1] || m[1] ? "type" : "re-export", signature, file: entry, line: i + 1 });
      }
      continue;
    }
    const eq = /^export\s*=\s*([\w$]+)/.exec(t);
    if (eq) assigned.push(eq[1]!);
  }
  for (const name of assigned) {
    let found = false;
    for (let i = 0; i < lines.length && out.length < MAX_EXPORTS; i++) {
      if (depthAt[i] !== 0) continue;
      const m = MEMBER.exec(lines[i]!.trim());
      if (!m || m[2] !== name || m[1] === "interface" || m[1] === "type") continue;
      found = true;
      if (m[1] !== "namespace") {
        out.push({ name, kind: `${KIND[m[1]!] ?? m[1]!} (export =)`, signature: signatureAt(lines, i), file: entry, line: i + 1 });
        continue;
      }
      // The namespace's own members: what `import x = require()` reaches as `x.member`.
      for (let j = i + 1; j < lines.length && depthAt[j]! > 0 && out.length < MAX_EXPORTS; j++) {
        if (depthAt[j] !== 1) continue;
        const k = MEMBER.exec(lines[j]!.trim());
        if (k) out.push({ name: `${name}.${k[2]}`, kind: KIND[k[1]!] ?? k[1]!, signature: signatureAt(lines, j), file: entry, line: j + 1 });
      }
    }
    if (!found) out.push({ name, kind: "export =", signature: `export = ${name}`, file: entry, line: 1 });
  }
  return truncated;
}

/** A JS entry's exports when the package ships no declarations: ESM `export`s and CommonJS assignments. */
async function readJsExports(entry: string, out: Export[]): Promise<void> {
  const lines = (await readFile(entry, "utf8").catch(() => "")).split(/\r?\n/);
  const seen = new Set<string>();
  const push = (name: string, kind: string, i: number) => {
    if (seen.has(name) || out.length >= MAX_EXPORTS) return;
    seen.add(name);
    out.push({ name, kind, signature: signatureAt(lines, i), file: entry, line: i + 1 });
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const d = DECL.exec(t);
    if (d) push(d[2]!, KIND[d[1]!] ?? d[1]!, i);
    const cjs = /^(?:module\.)?exports\.([\w$]+)\s*=/.exec(t);
    if (cjs) push(cjs[1]!, "export", i);
    const obj = /^module\.exports\s*=\s*\{([^}]*)\}?/.exec(t);
    if (obj) for (const n of obj[1]!.split(",").map((x) => /^\s*([\w$]+)/.exec(x)?.[1]).filter((x): x is string => !!x)) push(n, "export", i);
  }
}

/** The declaration of `name` among `exports`, with the doc comment above it, cut at its closing brace (60 lines). */
async function declarationOf(exports: Export[], name: string): Promise<InstalledPackageApi["declaration"] | undefined> {
  const hit = exports.find((e) => e.name === name && !e.signature.startsWith("export {")) ?? exports.find((e) => e.name === name);
  if (!hit) return undefined;
  let file = hit.file;
  let lines = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/);
  let at = hit.line - 1;
  // A re-export: the declaration of the name it re-exports, in its own file or the one it names.
  const re = /^export \{ ([\w$]+)(?: as [\w$]+)? \}(?: from ["']([^"']+)["'])?$/.exec(hit.signature);
  if (re) {
    const target = re[2] ? await resolveDts(hit.file, re[2]) : hit.file;
    if (target) {
      const tl = target === file ? lines : (await readFile(target, "utf8").catch(() => "")).split(/\r?\n/);
      const i = tl.findIndex((l) => MEMBER.exec(l.trim())?.[2] === re[1]);
      if (i >= 0) [file, lines, at] = [target, tl, i];
    }
  }
  let start = at;
  if (/\*\/\s*$/.test(lines[start - 1] ?? "")) {
    while (start > 0 && !/^\s*\/\*\*/.test(lines[start - 1]!)) start--;
    start = Math.max(0, start - 1);
  }
  const body: string[] = [];
  let depth = 0;
  for (let i = start; i < Math.min(lines.length, start + 60); i++) {
    const l = lines[i]!;
    body.push(l);
    if (i < at) continue;
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
    if (depth <= 0 && /[;}]\s*$/.test(l)) break;
  }
  return { text: body.join("\n"), file, line: start + 1 };
}

/**
 * `name`'s API as installed under the first of `dirs` that has it in
 * `node_modules` (its own declarations, then `@types/`), or null.
 */
export async function npmInstalledApi(dirs: readonly string[], name: string, symbol?: string): Promise<InstalledPackageApi | null> {
  if (!NAME.test(name) || name.includes("..")) return null;
  const typesName = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
  for (const base of dirs) {
    const dir = resolve(base, "node_modules", name);
    const pkg = await readJson(join(dir, "package.json"));
    if (!pkg) continue;
    let entry = await entryOf(dir, pkg);
    if (!entry?.typed) {
      const tdir = resolve(base, "node_modules", typesName);
      const tpkg = await readJson(join(tdir, "package.json"));
      const typed = tpkg ? await entryOf(tdir, tpkg) : null;
      if (typed?.typed) entry = typed;
    }
    const exports: Export[] = [];
    let truncated = false;
    if (entry?.typed) truncated = await readDeclarations(entry.file, exports, new Set());
    else if (entry) await readJsExports(entry.file, exports);
    const declaration = symbol ? await declarationOf(exports, symbol) : undefined;
    return {
      name,
      ...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
      source: entry?.file ?? join(dir, "package.json"),
      exports,
      ...(truncated || exports.length >= MAX_EXPORTS ? { truncated: true } : {}),
      ...(declaration ? { declaration } : {}),
    };
  }
  return null;
}
