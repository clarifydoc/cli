/**
 * A minimal structural reader for YAML and JSON documents — the skeleton an
 * API description (OpenAPI, AsyncAPI), a serverless descriptor or an
 * infrastructure template (CloudFormation/SAM) is read from: string-keyed
 * maps, sequences, scalar leaves and `$ref` strings, each with its 1-based line.
 * Shared by the plugins that read such documents and by core's deployment
 * readers, so neither imports the other.
 */

// OpenAPI's routing/schema skeleton is a tree of string-keyed maps and lists of
// maps; we need keys, nesting, scalar leaf values, list items and `$ref`
// strings — not full YAML (no anchors, no multi-line scalars). A focused indent
// parser avoids a YAML dependency (and the perf cost of one on every sniffed
// yaml). JSON specs are parsed with JSON.parse and folded into the same shape.

export interface SpecNode {
  value: string | null;
  line: number;
  children: Map<string, SpecNode>;
  /** Sequence items (`- name: id` / `- $ref: …` / `- read:users`), in order. */
  items?: SpecNode[];
}

export function newSpecNode(line: number): SpecNode {
  return { value: null, line, children: new Map() };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** The `$ref` of a node itself or, legacy shape, of its first `$ref` sequence item. */
function surfaceRef(parent: SpecNode, item: SpecNode): void {
  const ref = item.children.get("$ref");
  if (ref && !parent.children.has("$ref")) parent.children.set("$ref", ref);
}

/** Split `a, b: [c, d], {e: f}` at depth-0 commas. */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** `key: value` / `key:` — a mapping needs whitespace (or the end) after the colon, so `read:users` stays a scalar. */
const FLOW_KEY_RE = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:\[\]{},][^:]*?)\s*:(?:\s+(.*))?$/s;

/**
 * Fill `node` from a flow-style scalar (`[a, b]`, `{ type: integer }`,
 * `[bearerAuth: []]`, or a plain value). Recursive over nested flow syntax.
 */
function setFlowValue(node: SpecNode, raw: string): void {
  const text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    node.items = [];
    for (const part of splitFlow(text.slice(1, -1))) {
      const item = newSpecNode(node.line);
      const kv = FLOW_KEY_RE.exec(part);
      if (kv && !/^[\[{]/.test(part.trim())) {
        const child = newSpecNode(node.line);
        setFlowValue(child, kv[2] ?? "");
        item.children.set(stripQuotes(kv[1]!), child);
      } else if (/^\s*[\[{]/.test(part)) {
        setFlowValue(item, part);
      } else {
        item.value = stripQuotes(part);
      }
      node.items.push(item);
      surfaceRef(node, item);
    }
    return;
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    for (const part of splitFlow(text.slice(1, -1))) {
      const kv = FLOW_KEY_RE.exec(part);
      if (!kv) continue;
      const child = newSpecNode(node.line);
      setFlowValue(child, kv[2] ?? "");
      node.children.set(stripQuotes(kv[1]!), child);
    }
    return;
  }
  if (text && text !== "|" && text !== ">") node.value = stripQuotes(text);
}

/** Parse the map/sequence skeleton of a YAML document. */
function parseYaml(lines: string[]): SpecNode {
  const root = newSpecNode(1);
  const stack: Array<{ indent: number; node: SpecNode; isItem?: boolean }> = [{ indent: -1, node: root }];
  // A key may hold a colon not followed by a space (`Fn::GetAtt`, `x:y`), as YAML allows.
  const keyRe = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:](?:[^:]|:(?!\s|$))*?)\s*:(?:\s+|$)(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const seq = /^(\s*)-(?:\s+(.*))?$/.exec(raw);
    if (seq) {
      const indent = seq[1]!.length;
      const inline = (seq[2] ?? "").replace(/\s+#.*$/, "").trim();
      // Items sit deeper than their key but may share its column
      // (`security:\n- bearerAuth: []`): pop anything deeper, plus the
      // previous item at this same column — never the key itself.
      while (stack.length > 1) {
        const top = stack[stack.length - 1]!;
        if (top.indent > indent || (top.indent === indent && top.isItem)) stack.pop();
        else break;
      }
      const parent = stack[stack.length - 1]!.node;
      const item = newSpecNode(i + 1);
      (parent.items ??= []).push(item);
      stack.push({ indent, node: item, isItem: true });
      const kv = FLOW_KEY_RE.exec(inline);
      if (inline && kv && !/^[\[{]/.test(inline)) {
        const child = newSpecNode(i + 1);
        setFlowValue(child, kv[2] ?? "");
        item.children.set(stripQuotes(kv[1]!), child);
        // The inline key's siblings follow at the key's own column.
        const col = indent + 1 + (raw.slice(indent + 1).match(/^\s*/)?.[0].length ?? 1);
        stack.push({ indent: col, node: child });
      } else if (inline) {
        setFlowValue(item, inline);
      }
      surfaceRef(parent, item);
      continue;
    }
    const m = keyRe.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = stripQuotes(m[2]!);
    const rest = m[3]!.replace(/\s+#.*$/, "").trim();

    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    const node = newSpecNode(i + 1);
    setFlowValue(node, rest);
    parent.children.set(key, node);
    stack.push({ indent, node });
  }
  return root;
}

/** Fold a JSON.parse result into the SpecNode shape, tracking a best-effort line. */
function fromJson(obj: unknown, lines: string[], key: string, fromLine: number): SpecNode {
  const line = key ? findLine(lines, key, fromLine) : fromLine;
  const node = newSpecNode(line);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      node.children.set(k, fromJson(v, lines, k, line));
    }
  } else if (Array.isArray(obj)) {
    node.items = [];
    for (const el of obj) {
      const item = fromJson(el, lines, "", line);
      node.items.push(item);
      // Surface a $ref buried in an array (schema `allOf`) at this node.
      surfaceRef(node, item);
    }
  } else if (obj != null) {
    node.value = String(obj);
  }
  return node;
}

function findLine(lines: string[], key: string, fromLine: number): number {
  const needle = `"${key}"`;
  for (let i = Math.max(0, fromLine - 1); i < lines.length; i++) {
    if (lines[i]!.includes(needle)) return i + 1;
  }
  return fromLine;
}

const PARSE_CACHE = new WeakMap<string[], SpecNode>();

function parsedOf(lines: string[]): SpecNode {
  let root = PARSE_CACHE.get(lines);
  if (!root) {
    const text = lines.join("\n");
    if (/^\s*\{/.test(text)) {
      try {
        root = fromJson(JSON.parse(text), lines, "", 1);
      } catch {
        root = newSpecNode(1);
      }
    } else {
      root = parseYaml(lines);
    }
    PARSE_CACHE.set(lines, root);
  }
  return root;
}

/** The parsed skeleton of a YAML or JSON document, cached per `lines` array. */
export function parseSpecDocument(lines: string[]): SpecNode {
  return parsedOf(lines);
}
