/**
 * Flat `key → value` readers for the two configuration formats a server
 * program keeps its settings in: block YAML (`a:\n  b: x` → `a.b = x`) and
 * Java `.properties`. Scalars only — sequences, anchors and flow maps are
 * skipped, which loses nothing an address lives in. Leaf module.
 */

export interface ConfigKey {
  key: string;
  value: string;
  line: number;
  /** The YAML document it sits in (`---` separated), from 0. */
  doc: number;
}

/** Every scalar a block-YAML text sets, its key dotted from its parents. */
export function yamlKeys(text: string): ConfigKey[] {
  const out: ConfigKey[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let doc = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, "");
    if (/^---\s*$/.test(raw)) {
      doc++;
      stack.length = 0;
      continue;
    }
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*-/.test(raw)) continue;
    const m = /^(\s*)("[^"]+"|'[^']+'|[^\s:#][^:#]*?)\s*:(?:\s+(.*?))?\s*$/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = m[2]!.replace(/^["']|["']$/g, "").trim();
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const full = [...stack.map((s) => s.key), key].join(".");
    const value = (m[3] ?? "").replace(/\s+#.*$/, "").trim();
    if (!value || value === "|" || value === ">" || value.startsWith("&")) {
      stack.push({ indent, key });
      continue;
    }
    if (value.startsWith("[") || value.startsWith("{") || value.startsWith("*")) continue;
    out.push({ key: full, value: value.replace(/^"(.*)"$|^'(.*)'$/, "$1$2"), line: i + 1, doc });
  }
  return out;
}

/** Every `key=value` / `key: value` a `.properties` text sets (continuation lines joined). */
export function propertiesKeys(text: string): ConfigKey[] {
  const out: ConfigKey[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i]!.replace(/\r$/, "");
    while (/(?<!\\)\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i]!.replace(/\r$/, "").trimStart();
    if (/^\s*[#!]/.test(line) || !line.trim()) continue;
    const m = /^\s*([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m && m[2]!.trim()) out.push({ key: m[1]!, value: m[2]!.trim(), line: start + 1, doc: 0 });
  }
  return out;
}
