/**
 * A Go file's package-level string values, by name → `FileAnalysis.moduleValues`:
 *
 *     const ApiUri = "/api/v1"                 → ApiUri: "/api/v1"
 *     const DownloadUri = ApiUri + "/dl"       → DownloadUri: "${ApiUri}/dl"
 *     var ( Topic = getTopic() )               → Topic: "orders"
 *     func getTopic() string { if t := os.Getenv("TOPIC"); t != "" { return t }; return "orders" }
 *
 * Entries of `const (…)` / `var (…)` blocks count; values declared inside a
 * function do not. A value built from other names keeps them as `${…}` holes
 * (`config.ApiUri` stays a hole the project pass resolves in the `config`
 * package). A variable set from a function of this file is that function's
 * one literal result when its other results are names (an environment value
 * with a default) — the value the program has unless configured otherwise.
 * Only values that can name an endpoint or a channel are kept: no spaces, no
 * format verbs, at most 200 characters.
 */

const SINGLE = /^(?:const|var)\s+([A-Za-z_]\w*)(?:\s+string)?\s*=\s*(.+?)\s*(?:\/\/.*)?$/;
const IN_BLOCK = /^\s*([A-Za-z_]\w*)(?:\s+string)?\s*=\s*(.+?)\s*(?:\/\/.*)?$/;
const BLOCK_OPEN = /^(?:const|var)\s*\(\s*(?:\/\/.*)?$/;
const FUNC_DECL = /^func\s+([A-Za-z_]\w*)\s*\(\s*\)\s*string\s*\{\s*$/;
const STRING_TERM = /^"((?:[^"\\]|\\.)*)"$|^`([^`]*)`$/;
const NAME_TERM = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/;
const KEEP = /^[^\s%]{1,200}$/;

/** Net brace change on a line, ignoring braces inside string literals and comments. */
function braceDelta(line: string): number {
  const stripped = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "");
  let d = 0;
  for (const ch of stripped) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

/** Split `a + "b" + c` at top-level `+`, quotes honoured. */
function terms(expr: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') cur += expr[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "+" && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** `func mustMapEnv(target *string, envKey string) {` — a function handed a string field to set. */
const SETTER_DECL = /^func\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s+\*string\s*,\s*([A-Za-z_]\w*)\s+string\s*\)/;
/** `X := new(T)`, `X := &T{`, `X := T{`, `var X T`, `var X *T`. */
const LOCAL_TYPE = (name: string) => new RegExp(String.raw`\b${name}\s*:=\s*(?:new\(\s*\*?([A-Za-z_]\w*)\s*\)|&?([A-Za-z_]\w*)\s*\{)|\bvar\s+${name}\s+\*?([A-Za-z_]\w*)\b`);

/**
 * Struct fields the program sets from the environment, as `Type.field` →
 * `${os.Getenv("NAME")}`: `mustMapEnv(&svc.ordersAddr, "ORDERS_ADDR")` through a
 * function of this file that stores `os.Getenv(key)` in its pointer argument, or
 * `svc.ordersAddr = os.Getenv("ORDERS_ADDR")`, with `svc := new(frontendServer)`.
 * A handler reading `fe.ordersAddr` on a `*frontendServer` receiver names that
 * value; the call-origin pass reads the variable from the deployment.
 */
function envFieldValues(lines: string[]): Record<string, string> {
  const text = lines.join("\n");
  if (!/\bos\.(?:Getenv|LookupEnv)\(/.test(text)) return {};
  const setters = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = SETTER_DECL.exec(lines[i]!);
    if (!m) continue;
    const [, fn, target, key] = m;
    let depth = braceDelta(lines[i]!);
    let reads = false;
    let stores = false;
    for (let k = i + 1; k < lines.length && depth > 0; k++) {
      const l = lines[k]!;
      if (new RegExp(String.raw`\bos\.(?:Getenv|LookupEnv)\(\s*${key}\s*\)`).test(l)) reads = true;
      if (new RegExp(String.raw`\*${target}\s*=`).test(l)) stores = true;
      depth += braceDelta(l);
    }
    if (reads && stores) setters.add(fn!);
  }
  const out: Record<string, string> = {};
  const typeOf = (name: string, at: number): string | null => {
    const re = LOCAL_TYPE(name);
    for (let k = at; k >= 0 && at - k < 200; k--) {
      const m = re.exec(lines[k]!);
      if (m) return m[1] ?? m[2] ?? m[3] ?? null;
      if (/^func\b/.test(lines[k]!)) break;
    }
    return null;
  };
  const bind = (recv: string, field: string, env: string, at: number) => {
    const type = typeOf(recv, at);
    if (type && /^[A-Za-z_]\w*$/.test(type)) out[`${type}.${field}`] = `\${os.Getenv("${env}")}`;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    for (const m of l.matchAll(/\b([A-Za-z_]\w*)\(\s*&([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*,\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g)) {
      if (setters.has(m[1]!)) bind(m[2]!, m[3]!, m[4]!, i);
    }
    const direct = /^\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*os\.Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)\s*$/.exec(l);
    if (direct) bind(direct[1]!, direct[2]!, direct[3]!, i);
  }
  return out;
}

export function extractGoModuleValues(lines: string[]): Record<string, string> {
  const fields = envFieldValues(lines);
  return { ...extractPackageValues(lines), ...fields };
}

function extractPackageValues(lines: string[]): Record<string, string> {
  const text = lines.join("\n");
  if (!/^(?:const|var)\b/m.test(text)) return {};

  // Functions of this file returning one literal besides names: `getTopic()` → "orders".
  const defaults = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const fn = FUNC_DECL.exec(lines[i]!);
    if (!fn) continue;
    let depth = braceDelta(lines[i]!);
    const literals = new Set<string>();
    let other = false;
    for (let k = i + 1; k < lines.length && depth > 0; k++) {
      const ret = /^\s*return\s+(.+?)\s*(?:\/\/.*)?$/.exec(lines[k]!);
      if (ret) {
        const lit = STRING_TERM.exec(ret[1]!);
        if (lit) literals.add(lit[1] ?? lit[2] ?? "");
        else if (!/^[A-Za-z_]\w*$/.test(ret[1]!)) other = true;
      }
      depth += braceDelta(lines[k]!);
    }
    if (literals.size === 1 && !other) defaults.set(fn[1]!, [...literals][0]!);
  }

  const out: Record<string, string> = {};
  const clash = new Set<string>();
  const put = (name: string, expr: string): void => {
    let value = "";
    const call = /^([A-Za-z_]\w*)\(\s*\)$/.exec(expr);
    if (call) {
      const d = defaults.get(call[1]!);
      if (d === undefined) return;
      value = d;
    } else {
      for (const t of terms(expr)) {
        const lit = STRING_TERM.exec(t);
        if (lit) value += lit[1] ?? lit[2] ?? "";
        else if (NAME_TERM.test(t)) value += `\${${t}}`;
        else return;
      }
    }
    // Another package's name alone (`sarama.V3_0_0_0`) is not known to be a string.
    if (!KEEP.test(value) || /^\$\{\w+\.\w+\}$/.test(value)) return;
    if (name in out && out[name] !== value) clash.add(name);
    out[name] = value;
  };

  let depth = 0;
  let block = false;
  for (const line of lines) {
    if (depth === 0) {
      if (block) {
        if (/^\s*\)/.test(line)) block = false;
        else {
          const m = IN_BLOCK.exec(line);
          if (m) put(m[1]!, m[2]!);
        }
        depth += braceDelta(line);
        if (depth < 0) depth = 0;
        continue;
      }
      if (BLOCK_OPEN.test(line)) {
        block = true;
        continue;
      }
      const m = SINGLE.exec(line);
      if (m) put(m[1]!, m[2]!);
    }
    depth += braceDelta(line);
    if (depth < 0) depth = 0;
  }
  for (const c of clash) delete out[c];
  return out;
}
