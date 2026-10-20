import { readFileSync, existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { escapeRegex } from "../plugins/shared/path-utils.js";

/**
 * Import aliases a bundler config declares — Vite `resolve.alias`, webpack
 * `resolve.alias`, Vue CLI `configureWebpack.resolve.alias` — for projects
 * that never write them into a tsconfig (`'@': fileURLToPath(new URL('./src',
 * import.meta.url))`, chatwoot's `dashboard: path.resolve('./app/javascript/dashboard')`).
 *
 * The config is code, so only the spellings that state a path literally are
 * read: string literals (`'/resources/js'` is relative to the config's
 * directory, Vite's root), `path.resolve`/`path.join` over `__dirname`,
 * `process.cwd()` and string segments, `fileURLToPath(new URL('./x',
 * import.meta.url))`, and `${__dirname}/x` templates. An `alias: aliases`
 * names an object declared in the config or a file it imports relatively.
 * An entry is kept only when it points at something that exists in the
 * project — `vue: 'vue/dist/vue.esm.js'` swaps a package, not a directory.
 *
 * Output: alias prefix → absolute path, the shape `applyAliases` takes.
 */

const CONFIG_STEMS = ["vite.config", "webpack.config", "vue.config", "nuxt.config"];
const CONFIG_EXTS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const IMPORT_EXTS = ["", ".ts", ".mts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];

/** The bundler configs in `dir` (`vite.config.ts`, `webpack.config.js`, …). */
export function bundlerConfigsIn(dir: string): string[] {
  const out: string[] = [];
  for (const stem of CONFIG_STEMS) for (const ext of CONFIG_EXTS) {
    const p = join(dir, stem + ext);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Every alias the bundler configs of `dir` declare (first config wins a key). */
export function readBundlerAliases(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const config of bundlerConfigsIn(dir)) {
    for (const [k, v] of aliasesOfFile(config)) if (!out.has(k)) out.set(k, v);
    if (/[\\/]nuxt\.config\.\w+$/.test(config)) addNuxtAliases(config, dir, out);
  }
  return out;
}

/**
 * The aliases Nuxt itself defines, which a checkout never holds — they are
 * written into the generated `.nuxt/tsconfig.json` its tsconfig extends:
 * `~`/`@` → the source directory, `~~`/`@@` → the project root. The source
 * directory is the config's literal `srcDir`, else `app/` on Nuxt 4 (or 3 with
 * `compatibilityVersion: 4`) when it exists, else the root.
 */
function addNuxtAliases(config: string, dir: string, out: Map<string, string>): void {
  const code = readCode(config) ?? "";
  const declared = /\bsrcDir\s*:\s*(['"`])([^'"`$]+)\1/.exec(code);
  let srcDir = dir;
  if (declared) srcDir = resolve(dir, declared[2]!);
  else if (existsSync(join(dir, "app")) && (/\bcompatibilityVersion\s*:\s*4\b/.test(code) || nuxtMajor(dir) >= 4)) srcDir = join(dir, "app");
  if (!existsSync(srcDir)) return;
  for (const [key, target] of [["~", srcDir], ["@", srcDir], ["~~", dir], ["@@", dir]] as const) if (!out.has(key)) out.set(key, target);
}

/** The major version of `nuxt` the directory's package.json depends on (0 when unknown). */
function nuxtMajor(dir: string): number {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, Record<string, string> | undefined>;
    const range = pkg.dependencies?.nuxt ?? pkg.devDependencies?.nuxt ?? "";
    const m = /(\d+)/.exec(range);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function aliasesOfFile(file: string): Map<string, string> {
  const out = new Map<string, string>();
  const code = readCode(file);
  if (!code) return out;
  const dir = dirname(file);
  const re = /\balias\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const at = m.index + m[0].length;
    const value = valueAt(code, at);
    if (!value) continue;
    if (value.startsWith("{")) addObjectEntries(value, dir, out);
    else if (value.startsWith("[")) addArrayEntries(value, dir, out);
    else if (/^[A-Za-z_$][\w$]*$/.test(value)) {
      const obj = declaredObject(code, value) ?? importedObject(code, value, dir);
      if (obj) addObjectEntries(obj.text, obj.dir || dir, out);
    }
  }
  return out;
}

/** `{ '@': x, dashboard: y }` → entries (spreads and computed keys are skipped). */
function addObjectEntries(obj: string, dir: string, out: Map<string, string>): void {
  for (const part of splitTopLevel(obj.slice(1, -1))) {
    const kv = /^\s*(?:(['"`])([^'"`]+)\1|([A-Za-z_$@~#][\w$@~#/.-]*))\s*:\s*([^]+)$/.exec(part);
    if (!kv) continue;
    addEntry(kv[2] ?? kv[3]!, kv[4]!, dir, out);
  }
}

/** `[{ find: '@', replacement: x }]` → entries (a RegExp `find` is skipped). */
function addArrayEntries(arr: string, dir: string, out: Map<string, string>): void {
  for (const part of splitTopLevel(arr.slice(1, -1))) {
    const t = part.trim();
    if (!t.startsWith("{")) continue;
    let find: string | null = null;
    let replacement: string | null = null;
    for (const field of splitTopLevel(t.slice(1, -1))) {
      const kv = /^\s*(find|replacement)\s*:\s*([^]+)$/.exec(field);
      if (!kv) continue;
      if (kv[1] === "find") find = stringLiteral(kv[2]!.trim());
      else replacement = kv[2]!;
    }
    if (find && replacement) addEntry(find, replacement, dir, out);
  }
}

function addEntry(rawKey: string, expr: string, dir: string, out: Map<string, string>): void {
  // `vue$` is webpack's exact-match form; `@/` and `@/*` name the `@` prefix.
  if (rawKey.endsWith("$")) return;
  const key = rawKey.replace(/\/\*?$/, "");
  if (!key || out.has(key)) return;
  const target = evalPath(expr.trim(), dir);
  if (target && existsSync(target)) out.set(key, target);
}

/** The absolute path an alias value names, or null when it is not a literal path. */
function evalPath(expr: string, dir: string): string | null {
  const literal = stringLiteral(expr);
  if (literal !== null) {
    if (literal.startsWith("/")) return join(dir, literal);
    if (literal.startsWith("./") || literal.startsWith("../")) return resolve(dir, literal);
    return null;
  }
  const url = /^fileURLToPath\(\s*new\s+URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)\s*\)$/.exec(expr)
    ?? /^new\s+URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)\.pathname$/.exec(expr);
  if (url) return resolve(dir, url[2]!);
  const tpl = /^`\$\{(?:__dirname|import\.meta\.dirname|process\.cwd\(\))\}([^`$]*)`$/.exec(expr);
  if (tpl) return join(dir, tpl[1]!);
  const call = /^(?:[\w$]+\.)?(resolve|join)\(([^]*)\)$/.exec(expr);
  if (!call) return null;
  let path = dir;
  for (const arg of splitTopLevel(call[2]!)) {
    const a = arg.trim();
    if (a === "__dirname" || a === "process.cwd()" || a === "import.meta.dirname") path = dir;
    else if (/^fileURLToPath\(\s*new\s+URL\(\s*(['"`])\.\/?\1\s*,\s*import\.meta\.url\s*\)\s*\)$/.test(a)) path = dir;
    else {
      const seg = stringLiteral(a);
      if (seg === null) return null;
      path = call[1] === "resolve" ? resolve(path, seg) : join(path, seg);
    }
  }
  return path === dir ? null : path;
}

function stringLiteral(expr: string): string | null {
  const m = /^(['"`])([^'"`$]*)\1$/.exec(expr.trim());
  return m ? m[2]! : null;
}

/** `const aliases = { … }` (optionally exported) in `code`. */
function declaredObject(code: string, name: string): { text: string; dir: string } | null {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(name)}\\s*(?::[^=]+)?=\\s*`);
  const m = re.exec(code);
  if (!m) return null;
  const text = valueAt(code, m.index + m[0].length);
  return text?.startsWith("{") ? { text, dir: "" } : null;
}

/** `import { aliases } from './vite.shared'` → that file's declaration of `aliases`. */
function importedObject(code: string, name: string, dir: string): { text: string; dir: string } | null {
  const re = /import\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const names = m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop());
    if (!names.includes(name)) continue;
    for (const ext of IMPORT_EXTS) {
      const file = resolve(dir, m[3]! + ext);
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const other = readCode(file);
      const obj = other ? declaredObject(other, name) : null;
      return obj ? { text: obj.text, dir: dirname(file) } : null;
    }
  }
  return null;
}

/** The balanced value starting at `at`: an object, an array, or an identifier. */
function valueAt(code: string, at: number): string | null {
  const open = code[at];
  if (open === "{" || open === "[") {
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = at; i < code.length; i++) {
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === "`") { i = skipString(code, i); continue; }
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") {
        depth--;
        if (depth === 0) return ch === close ? code.slice(at, i + 1) : null;
      }
    }
    return null;
  }
  return /^[A-Za-z_$][\w$]*/.exec(code.slice(at))?.[0] ?? null;
}

/** Split on top-level commas, outside brackets and strings. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") { i = skipString(s, i); continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (s.slice(start).trim()) out.push(s.slice(start));
  return out;
}

/** Index of the quote closing the string opened at `i`. */
function skipString(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === q) return j;
  }
  return s.length;
}

/** The file's text without comments (strings kept), or null when unreadable. */
function readCode(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipString(text, i);
      out += text.slice(i, end + 1);
      i = end;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}
