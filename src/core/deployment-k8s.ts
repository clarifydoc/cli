import { glob } from "./glob.js";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import {
  IGNORE,
  NON_RUNTIME_RE,
  isImageRef,
  parseSimpleYaml,
  type RawService,
  type YamlMap,
  type YamlValue,
} from "./deployment.js";

/**
 * Kubernetes / Helm manifests as a deployment-topology source.
 *
 * Everything downstream (classification, project matching, env-evidence
 * edges) already runs on the compose-shaped {@link RawService}, so this module
 * only has to translate k8s workloads into that shape:
 *
 *   - Deployment / StatefulSet / DaemonSet / Job / CronJob → one RawService
 *     (name, first container's image, container env merged with referenced
 *     ConfigMap data — that env is where the URL / connection-string evidence
 *     lives, exactly as in compose).
 *   - `kind: Service` objects are recorded as ALIASES onto the workload their
 *     selector targets: k8s URLs point at Service DNS names
 *     (`http://user-svc`), while the deployable unit may be named
 *     `user-deployment` — without the alias no URL edge would ever resolve.
 *   - Helm templates are rendered best-effort before parsing: `{{ .Values.x }}`
 *     resolves against the chart's values.yaml, `{{ include "x.fullname" . }}`
 *     / `.Release.Name` / `.Chart.Name` degrade to the chart name, control-flow
 *     lines ({{- if }}, {{- end }}) are dropped, anything else becomes "".
 *     A partially-rendered manifest still yields names, images and literal env
 *     values — which is all the evidence engine reads.
 *
 * Discovery is sniff-based (a yaml must carry `apiVersion:` + a workload-ish
 * `kind:`), so CI configs, lint configs and OpenAPI yamls never parse.
 */

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);
const K8S_SNIFF_RE = /^\s*apiVersion\s*:/m;
const K8S_KIND_RE = /^\s*kind\s*:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob|Service|ConfigMap|Ingress)\s*$/m;

// ─── Safe YAML traversal ─────────────────────────────────────────────────────

function asMap(v: YamlValue | undefined): YamlMap | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

/** The value as a sequence, or an empty one. */
function asList(v: YamlValue | undefined): YamlValue[] {
  return Array.isArray(v) ? v : [];
}

/** The value as a non-empty string, or undefined. */
function asString(v: YamlValue | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Follow a key path through nested maps; undefined as soon as a step is missing. */
function dig(m: YamlMap | undefined, ...path: string[]): YamlValue | undefined {
  let cur: YamlValue | undefined = m;
  for (const key of path) {
    cur = asMap(cur)?.[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

// ─── Helm template rendering (best-effort) ──────────────────────────────────

/** What a Helm template is rendered against: the chart's name and its values. */
export interface ChartContext {
  /** Chart name from Chart.yaml — stands in for Release/fullname helpers. */
  name: string;
  /** Parsed values.yaml (empty map when absent). */
  values: YamlMap;
  /** Chart.yaml `appVersion` / `version`, for `.Chart.AppVersion` / `.Chart.Version`. */
  appVersion?: string;
  version?: string;
  /** The chart's named templates (`{{ define "x.fullname" }}…{{ end }}`, mostly in `_helpers.tpl`): name → body. */
  defines?: ReadonlyMap<string, string>;
}

/** What one expression renders to; `exact: false` when part of it is a stand-in or unknown. */
interface Rendered {
  text: string;
  exact: boolean;
}

const UNKNOWN: Rendered = { text: "", exact: false };

/** `a.b.c` path into a values map. */
function valuesAt(values: YamlValue | undefined, path: string): YamlValue | undefined {
  let cur: YamlValue | undefined = values;
  for (const seg of path.split(".").filter(Boolean)) {
    cur = asMap(cur)?.[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Go-template truth: empty, `false`, `0` and null are false; so are empty maps and lists. */
function truthy(v: YamlValue | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "string") return !/^(?:|false|0|null|~)$/i.test(v.trim());
  return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0;
}

/** Words of a pipeline segment, quoted strings kept whole. */
function words(segment: string): string[] {
  return segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
}

/** Split on `|` outside quotes. */
function pipeSegments(expr: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of expr) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "|") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Scope a template line is rendered in: the chart, and what `.` is inside `with`. */
interface Scope {
  chart: ChartContext | undefined;
  /** Values path `.` stands for inside `{{ with .Values.x }}`; null when unknown (inside `range`). */
  dot: string | null | undefined;
  /** Template variables (`$name := …`) inside a named template's body. */
  vars?: Map<string, Rendered>;
  /** How deep in `include`s this is: bounded, a template may include itself. */
  depth?: number;
}

/** The value one operand names (`.Values.a.b`, `.x` under `with`); undefined when it names nothing known. */
function operandValue(w: string, scope: Scope): { value: YamlValue | undefined; known: boolean } {
  const values = scope.chart?.values ?? {};
  const v = /^\$?\.Values\.([\w.-]+)$/.exec(w);
  if (v) return { value: scope.chart ? valuesAt(values, v[1]!) : undefined, known: !!scope.chart };
  if (w === "." || /^\.[\w-]+(?:\.[\w-]+)*$/.test(w)) {
    if (scope.dot === undefined || scope.dot === null || /^\.(?:Release|Chart|Capabilities|Template|Files)\b/.test(w)) return { value: undefined, known: false };
    const path = w === "." ? scope.dot : `${scope.dot}.${w.slice(1)}`;
    return { value: valuesAt(values, path), known: true };
  }
  return { value: undefined, known: false };
}

/** One operand as text: a literal, a values path, a chart field — or a stand-in for what cannot be known. */
function renderOperand(w: string, scope: Scope): Rendered {
  const variable = /^\$(\w+)$/.exec(w);
  if (variable) return scope.vars?.get(variable[1]!) ?? UNKNOWN;
  if (/^".*"$/.test(w)) return { text: w.slice(1, -1).replace(/\\(.)/g, "$1"), exact: true };
  if (/^'.*'$/.test(w)) return { text: w.slice(1, -1), exact: true };
  if (/^-?\d+(?:\.\d+)?$/.test(w) || w === "true" || w === "false") return { text: w, exact: true };
  const chart = scope.chart;
  if (/^\$?\.Chart\.Name$/.test(w)) return chart ? { text: chart.name, exact: true } : UNKNOWN;
  if (/^\$?\.Chart\.AppVersion$/.test(w)) return chart?.appVersion ? { text: chart.appVersion, exact: true } : UNKNOWN;
  if (/^\$?\.Chart\.Version$/.test(w)) return chart?.version ? { text: chart.version, exact: true } : UNKNOWN;
  // The release name is chosen at install time: the chart name stands in for it.
  if (/^\$?\.Release\.Name$/.test(w)) return { text: chart?.name ?? "", exact: false };
  if (/^\$?\.Release\.Service$/.test(w)) return { text: "Helm", exact: true };
  const { value, known } = operandValue(w, scope);
  if (!known) return UNKNOWN;
  if (value === undefined) return { text: "", exact: true };
  return typeof value === "string" ? { text: value, exact: true } : UNKNOWN;
}

/**
 * One pipeline segment: a function applied to its arguments and, after the
 * first segment, to the piped value (Go templates pass it as the LAST argument).
 */
function renderSegment(segment: string, piped: Rendered | null, scope: Scope): Rendered {
  const [fn, ...rest] = words(segment);
  if (!fn) return piped ?? UNKNOWN;
  if (/^[($]/.test(fn) && !/^\$\./.test(fn)) return UNKNOWN; // a sub-expression or a variable
  const args = rest.map((w) => (/^\(/.test(w) ? UNKNOWN : renderOperand(w, scope)));
  if (piped) args.push(piped);
  const all = (text: string) => ({ text, exact: args.every((a) => a.exact) });
  switch (fn) {
    case "default": {
      // `default D V`: V unless it is empty.
      const [d, v] = args;
      if (!d || !v) return UNKNOWN;
      return v.text ? v : d;
    }
    case "quote":
      return args.length === 1 ? all(`"${args[0]!.text}"`) : UNKNOWN;
    case "squote":
      return args.length === 1 ? all(`'${args[0]!.text}'`) : UNKNOWN;
    case "toString":
    case "trim":
      return args.length === 1 ? all(fn === "trim" ? args[0]!.text.trim() : args[0]!.text) : UNKNOWN;
    case "lower":
    case "upper":
      return args.length === 1 ? all(fn === "lower" ? args[0]!.text.toLowerCase() : args[0]!.text.toUpperCase()) : UNKNOWN;
    case "trimSuffix":
    case "trimPrefix": {
      const [affix, v] = args;
      if (!affix || !v) return UNKNOWN;
      const text = fn === "trimSuffix" ? (v.text.endsWith(affix.text) ? v.text.slice(0, v.text.length - affix.text.length) : v.text) : v.text.startsWith(affix.text) ? v.text.slice(affix.text.length) : v.text;
      return all(text);
    }
    case "printf": {
      const [format, ...vals] = args;
      if (!format) return UNKNOWN;
      let i = 0;
      return all(format.text.replace(/%[svdq]/g, () => vals[i++]?.text ?? ""));
    }
    case "trunc": {
      const [n, v] = args;
      const k = Number(n?.text);
      if (!n || !v || !Number.isFinite(k)) return UNKNOWN;
      return all(k >= 0 ? v.text.slice(0, k) : v.text.slice(k));
    }
    case "nindent":
    case "indent": {
      const [n, v] = args;
      const k = Number(n?.text);
      if (!n || !v || !Number.isFinite(k)) return UNKNOWN;
      const pad = " ".repeat(Math.max(0, k));
      const text = v.text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
      return all(fn === "nindent" ? `\n${text}` : text);
    }
    case "replace": {
      const [from, to, v] = args;
      if (!from || !to || !v) return UNKNOWN;
      return all(v.text.split(from.text).join(to.text));
    }
    case "required":
      // `required "msg" .Values.x`: the value, when it is there.
      return args.length === 2 && args[1]!.text ? args[1]! : UNKNOWN;
    case "include":
    case "template": {
      // A named template the chart defines is rendered in its own scope: `.` is what the call passes.
      const name = args[0];
      const body = name?.exact ? scope.chart?.defines?.get(name.text) : undefined;
      const depth = (scope.depth ?? 0) + 1;
      if (body !== undefined && depth <= 6) {
        const passed = rest[1];
        const dot = passed === "." || passed === "$" ? scope.dot : passed && /^\$?\.Values\.([\w.-]+)$/.test(passed) ? passed.replace(/^\$?\.Values\./, "") : null;
        return renderNamedTemplate(body, { chart: scope.chart, dot: passed === undefined ? undefined : dot, depth });
      }
      // Not defined here: the chart name stands in (it is what `*.fullname` usually renders).
      return { text: scope.chart?.name ?? (name?.text.split(".")[0] ?? ""), exact: false };
    }
    default:
      if (!piped && !rest.length) return renderOperand(fn, scope);
      return UNKNOWN;
  }
}

/** What one `{{ … }}` expression renders to. */
function renderHelmExpr(expr: string, scope: Scope): Rendered {
  const e = expr.trim();
  if (e.startsWith("/*") || e === "") return { text: "", exact: true };
  let piped: Rendered | null = null;
  for (const seg of pipeSegments(e)) piped = renderSegment(seg, piped, scope);
  return piped ?? UNKNOWN;
}

/** A condition's truth: true / false, or null when it cannot be decided from the values. */
function decide(cond: string, scope: Scope): boolean | null {
  const w = words(cond.trim());
  // `contains SUB S`, and a variable alone: decided on what they render to.
  if (w.length === 3 && w[0] === "contains") {
    const sub = renderOperand(w[1]!, scope);
    const str = renderOperand(w[2]!, scope);
    return sub.exact && str.exact ? str.text.includes(sub.text) : null;
  }
  if (w.length === 1 && /^\$\w+$/.test(w[0]!)) {
    const v = renderOperand(w[0]!, scope);
    return v.exact ? truthy(v.text) : null;
  }
  const val = (x: string | undefined): YamlValue | undefined | null => {
    if (x === undefined) return null;
    if (/^".*"$|^'.*'$/.test(x)) return x.slice(1, -1);
    const { value, known } = operandValue(x, scope);
    return known ? value : null;
  };
  if (w.length === 1) {
    const v = val(w[0]);
    return v === null ? null : truthy(v);
  }
  if (w.length === 2 && w[0] === "not") {
    const v = val(w[1]);
    return v === null ? null : !truthy(v);
  }
  if (w.length === 3 && (w[0] === "eq" || w[0] === "ne")) {
    const a = val(w[1]);
    const b = val(w[2]);
    if (a === null || b === null || (a !== undefined && typeof a !== "string") || (b !== undefined && typeof b !== "string")) return null;
    return (a ?? "") === (b ?? "") ? w[0] === "eq" : w[0] === "ne";
  }
  return null;
}

/** A template's text split into literal text and `{{ actions }}`, with the trim markers applied. */
function templateTokens(body: string): Array<{ text?: string; action?: string }> {
  const out: Array<{ text?: string; action?: string }> = [];
  const re = /\{\{(-?)\s*([\s\S]*?)\s*(-?)\}\}/g;
  let last = 0;
  let trimNext = false;
  for (const m of body.matchAll(re)) {
    let text = body.slice(last, m.index);
    if (trimNext) text = text.replace(/^\s+/, "");
    if (m[1]) text = text.replace(/\s+$/, "");
    if (text) out.push({ text });
    out.push({ action: m[2]! });
    trimNext = !!m[3];
    last = m.index! + m[0].length;
  }
  let tail = body.slice(last);
  if (trimNext) tail = tail.replace(/^\s+/, "");
  if (tail) out.push({ text: tail });
  return out;
}

/**
 * A named template's body, rendered: its text and actions in order, `if` /
 * `else if` / `else` / `with` decided as the line renderer decides them,
 * `range` bodies unknown, `$variables` assigned and read. Exact only when
 * everything it printed was, and every branch on the way was decided.
 */
function renderNamedTemplate(body: string, scope: Scope): Rendered {
  const vars = new Map<string, Rendered>();
  const inner: Scope = { ...scope, vars };
  const frames: Array<{ kind: string; active: boolean | null; taken: boolean | null }> = [];
  let text = "";
  let exact = true;
  const live = () => !frames.some((f) => f.active === false);
  for (const t of templateTokens(body)) {
    if (t.text !== undefined) {
      if (live()) {
        text += t.text;
        if (frames.some((f) => f.active === null)) exact = false;
      }
      continue;
    }
    const a = t.action!;
    const kw = /^(if|else if|else|end|with|range|define|block)\b\s*([\s\S]*)$/.exec(a);
    if (kw) {
      const [, k, arg] = kw;
      const top = frames[frames.length - 1];
      if (k === "end") frames.pop();
      else if (k === "else" || k === "else if") {
        if (top) {
          const cond = k === "else if" ? decide(arg!, inner) : true;
          const before = top.taken;
          top.active = before === true ? false : before === null || cond === null ? null : cond;
          top.taken = before === true || top.active === true ? true : before === null || cond === null ? null : false;
        }
      } else if (k === "if" || k === "with") {
        let d = live() ? decide(arg!, inner) : false;
        // `contains $name .Release.Name`: decided on the stand-in's text, so one branch prints — inexactly.
        const c = d === null ? /^contains\s+(\S+)\s+(\S+)$/.exec(arg!.trim()) : null;
        if (c) {
          d = renderOperand(c[2]!, inner).text.includes(renderOperand(c[1]!, inner).text);
          exact = false;
        }
        frames.push({ kind: k, active: d, taken: d });
      } else frames.push({ kind: k!, active: k === "range" ? null : false, taken: null });
      continue;
    }
    if (!live()) continue;
    const assign = /^\$(\w+)\s*:?=\s*([\s\S]+)$/.exec(a);
    if (assign) {
      vars.set(assign[1]!, renderHelmExpr(assign[2]!, inner));
      continue;
    }
    const r = renderHelmExpr(a, inner);
    text += r.text;
    if (!r.exact || frames.some((f) => f.active === null)) exact = false;
  }
  return { text, exact };
}

/**
 * The named templates in a chart's template files: `{{ define "name" }}`
 * to the `{{ end }}` that closes it, counting the blocks opened inside.
 */
export function chartDefines(texts: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const action = /\{\{-?\s*(define|if|with|range|block|end)\b\s*("[^"]*")?[^}]*?-?\}\}/g;
  for (const text of texts) {
    let open: { name: string; from: number } | null = null;
    let depth = 0;
    for (const m of text.matchAll(action)) {
      const kw = m[1]!;
      if (!open) {
        if (kw === "define" && m[2]) {
          open = { name: m[2].slice(1, -1), from: m.index! + m[0].length };
          depth = 0;
        }
        continue;
      }
      if (kw === "end") {
        if (depth === 0) {
          // The body, with the define's own trim markers: `-}}` after the name, `{{-` before its end.
          let body = text.slice(open.from, m.index);
          if (/-\}\}$/.test(text.slice(0, open.from))) body = body.replace(/^\s+/, "");
          if (m[0].startsWith("{{-")) body = body.replace(/\s+$/, "");
          if (!out.has(open.name)) out.set(open.name, body);
          open = null;
        } else depth--;
      } else depth++;
    }
  }
  return out;
}

/** Lines that are pure template control flow — no YAML content survives them. */
const HELM_CONTROL_RE = /^\{\{-?\s*(if|else if|else|end|range|with|define|block)\b([^}]*?)\s*-?\}\}$/;

/** A key that names a container image. */
const IMAGE_LINE_RE = /^(\s*(?:-\s+)?image:\s*)/;

interface Frame {
  kind: "if" | "with" | "range" | "define";
  /** Whether lines are emitted: true, false, or null when undecidable (emitted, but not exact). */
  active: boolean | null;
  /** Whether an earlier branch of this `if` was already taken. */
  taken: boolean | null;
  dot?: string | null;
}

/**
 * Rendering of a Helm template into plain YAML, against the chart's default
 * values.
 *
 * `if`/`else if`/`else` and `with` are decided against the values file when
 * they test a value (`if .Values.x`, `not`, `eq`/`ne` with a literal); the
 * branch not taken is dropped. A condition that cannot be decided keeps its
 * lines but marks them inexact; inside `range`, `.` is unknown. `define`
 * bodies are never output. Expressions read values (with `default`, `quote`,
 * `printf`, `trimSuffix`…), `.Chart.AppVersion`/`.Version`/`.Name`; a named
 * template (`include`) and `.Release.Name` render as the chart name, a stand-in.
 *
 * The rule for images: an `image:` line built from anything not known exactly
 * renders empty — no image, never a guessed one.
 *
 * @param text - The template source
 * @param chart - The chart context, or undefined when no Chart.yaml was found
 * @returns YAML text for `parseSimpleYaml`
 */
export function renderHelmTemplate(text: string, chart: ChartContext | undefined): string {
  const out: string[] = [];
  const stack: Frame[] = [];
  const scope = (): Scope => {
    let dot: string | null | undefined;
    for (const f of stack) if (f.kind === "with" || f.kind === "range") dot = f.dot;
    return { chart, dot };
  };
  for (const raw of text.split(/\r?\n/)) {
    const control = HELM_CONTROL_RE.exec(raw.trim());
    if (control) {
      const kw = control[1]!;
      const arg = control[2]!.trim();
      const top = stack[stack.length - 1];
      if (kw === "end") stack.pop();
      else if (kw === "else" || kw === "else if") {
        if (top?.kind === "if" || top?.kind === "with") {
          const cond = kw === "else if" ? decide(arg, scope()) : true;
          const before = top.taken;
          top.active = before === true ? false : before === null || cond === null ? null : cond;
          top.taken = before === true || top.active === true ? true : before === null || cond === null ? null : false;
        }
      } else if (kw === "if") {
        const d = decide(arg, scope());
        stack.push({ kind: "if", active: d, taken: d });
      } else if (kw === "with") {
        const m = /^\$?\.Values\.([\w.-]+)$/.exec(arg);
        const d = decide(arg, scope());
        stack.push({ kind: "with", active: d, taken: d, dot: m ? m[1]! : null });
      } else if (kw === "range") {
        // A range body is emitted once; what `.` is inside it is not known.
        stack.push({ kind: "range", active: true, taken: true, dot: null });
      } else stack.push({ kind: "define", active: false, taken: false });
      continue;
    }
    if (stack.some((f) => f.active === false)) continue;
    const inexactBlock = stack.some((f) => f.active === null);
    const sc = scope();
    let exact = !inexactBlock;
    const line = raw.replace(/\{\{-?\s*([^{}]*?)\s*-?\}\}/g, (_, expr: string) => {
      const r = renderHelmExpr(expr, sc);
      if (!r.exact) exact = false;
      return r.text;
    });
    const img = IMAGE_LINE_RE.exec(line);
    if (img && raw.includes("{{") && !exact) {
      out.push(img[1]!.trimEnd());
      continue;
    }
    if (img && inexactBlock) {
      out.push(img[1]!.trimEnd());
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// ─── Workload → RawService ──────────────────────────────────────────────────

/**
 * k8s container env. `value:` literals pass through; `valueFrom` secret /
 * ConfigMap references synthesize a `${refName.key}` placeholder — the secret
 * VALUE is unknowable, but its NAME carries identity (`user-api-db` /
 * `plan-connection`) that the evidence engine's placeholder inference reads.
 */
function containerEnv(container: YamlMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of asList(container.env)) {
    const m = asMap(item);
    const name = asString(m?.name);
    if (!name) continue;
    const value = m ? m.value : undefined;
    if (typeof value === "string" && value) {
      out[name] = value;
      continue;
    }
    for (const refKind of ["secretKeyRef", "configMapKeyRef"] as const) {
      const refName = asString(dig(m, "valueFrom", refKind, "name"));
      if (refName) {
        const key = asString(dig(m, "valueFrom", refKind, "key"));
        out[name] = "${" + refName + (key ? "." + key : "") + "}";
        break;
      }
    }
  }
  return out;
}

/** Names of ConfigMaps referenced via `envFrom: - configMapRef: {name}`. */
function configMapRefs(container: YamlMap): string[] {
  const out: string[] = [];
  for (const item of asList(container.envFrom)) {
    const name = asString(dig(asMap(item), "configMapRef", "name"));
    if (name) out.push(name);
  }
  return out;
}

interface K8sDoc {
  kind: string;
  name: string;
  doc: YamlMap;
}

/**
 * Split a multi-document YAML file on `---` and parse every chunk that looks
 * like a Kubernetes object (has `kind` and `metadata.name`).
 */
function docsOf(text: string): K8sDoc[] {
  const out: K8sDoc[] = [];
  for (const chunk of text.split(/^---\s*$/m)) {
    if (!K8S_SNIFF_RE.test(chunk)) continue;
    const doc = parseSimpleYaml(chunk);
    const kind = asString(doc.kind);
    const name = asString(dig(doc, "metadata", "name"));
    if (kind && name) out.push({ kind, name, doc });
  }
  return out;
}

/** The pod template spec, per workload flavor (CronJob nests one level deeper). */
function podSpec(kind: string, doc: YamlMap): YamlMap | undefined {
  if (kind === "CronJob") {
    return asMap(dig(doc, "spec", "jobTemplate", "spec", "template", "spec"));
  }
  return asMap(dig(doc, "spec", "template", "spec"));
}

/** Pod-template labels — what a Service selector matches against. */
function podLabels(kind: string, doc: YamlMap): YamlMap {
  const base = kind === "CronJob" ? dig(doc, "spec", "jobTemplate", "spec", "template", "metadata", "labels")
    : dig(doc, "spec", "template", "metadata", "labels");
  return asMap(base) ?? {};
}

/**
 * Everything the Kubernetes/Helm manifests of a repo contribute to the
 * deployment model, translated into the compose-shaped `RawService` records.
 */
export interface K8sManifests {
  /** Repo-relative posix paths of every manifest that contributed. */
  files: string[];
  /** One RawService group per manifest file (a file is a stack scope). */
  groups: RawService[][];
  /** k8s Service name → workload name (URL hosts point at Service DNS names). */
  aliases: Map<string, string>;
  /**
   * Ingress → backend edges. `to` is the k8s SERVICE name as written in the
   * Ingress rule — the caller resolves it through `aliases` onto the workload.
   */
  ingressEdges: Array<{ from: string; to: string; host?: string }>;
}

/**
 * Discover and translate k8s/Helm manifests under `projectRoot`.
 * Returns undefined when the repo carries none.
 */
export async function collectK8sManifests(
  projectRoot: string,
  opts: { maxFiles?: number } = {},
): Promise<K8sManifests | undefined> {
  const absRoot = resolve(projectRoot);
  const found = await glob(["**/*.{yml,yaml}"], {
    cwd: absRoot,
    ignore: [...IGNORE, "**/.github/**", "**/.gitlab/**", "**/.circleci/**"],
    absolute: false,
    caseSensitiveMatch: false,
    deep: 7,
  });

  // Chart roots first — a template file resolves values against its chart.
  const charts = new Map<string, ChartContext>(); // chart dir (posix, no trailing /) → ctx
  for (const rel of found) {
    const posix = rel.split("\\").join("/");
    if (!/(^|\/)Chart\.ya?ml$/.test(posix)) continue;
    const dir = posix.replace(/\/?Chart\.ya?ml$/i, "");
    try {
      const chartDoc = parseSimpleYaml(await readFile(join(absRoot, posix), "utf-8"));
      let values: YamlMap = {};
      for (const vf of ["values.yaml", "values.yml"]) {
        try {
          values = parseSimpleYaml(await readFile(join(absRoot, dir, vf), "utf-8"));
          break;
        } catch { /* no values file */ }
      }
      const appVersion = asString(chartDoc.appVersion);
      const version = asString(chartDoc.version);
      // Named templates: `_helpers.tpl` and any template file that defines one.
      const templateFiles = await glob(["templates/**/*.{tpl,yaml,yml}"], { cwd: join(absRoot, dir), absolute: false, deep: 4 }).catch(() => [] as string[]);
      const texts: string[] = [];
      for (const f of templateFiles.slice(0, 200)) {
        try {
          const t = await readFile(join(absRoot, dir, f), "utf-8");
          if (t.includes("define")) texts.push(t);
        } catch { /* unreadable template */ }
      }
      const defines = chartDefines(texts);
      charts.set(dir, {
        name: asString(chartDoc.name) ?? dir.split("/").pop() ?? "chart",
        values,
        ...(appVersion ? { appVersion } : {}),
        ...(version ? { version } : {}),
        ...(defines.size ? { defines } : {}),
      });
    } catch { /* unreadable chart */ }
  }

  const candidates = found
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !/compose/i.test(f.split("/").pop() ?? "")) // compose is handled elsewhere
    .filter((f) => !/(^|\/)(Chart|values)\.ya?ml$/i.test(f))
    .filter((f) => f.split("/").every((seg) => !NON_RUNTIME_RE.test(seg)))
    .sort()
    .slice(0, opts.maxFiles ?? 80);

  const files: string[] = [];
  const groups: RawService[][] = [];
  const aliases = new Map<string, string>();
  const ingressEdges: Array<{ from: string; to: string; host?: string }> = [];
  // ConfigMaps pool across all manifests — envFrom references resolve by name.
  const configMaps = new Map<string, Record<string, string>>();
  const pending: Array<{ file: string; docs: K8sDoc[] }> = [];

  for (const rel of candidates) {
    let text: string;
    try {
      text = await readFile(join(absRoot, rel), "utf-8");
    } catch {
      continue;
    }
    if (text.length > 1_000_000) continue;

    if (text.includes("{{")) {
      // Helm template — render against the nearest enclosing chart.
      let chart: ChartContext | undefined;
      let dir = rel.split("/").slice(0, -1).join("/");
      while (dir) {
        const c = charts.get(dir.replace(/\/templates$/, "")) ?? charts.get(dir);
        if (c) { chart = c; break; }
        dir = dir.split("/").slice(0, -1).join("/");
      }
      text = renderHelmTemplate(text, chart);
    }

    if (!K8S_SNIFF_RE.test(text) || !K8S_KIND_RE.test(text)) continue;

    const docs = docsOf(text);
    if (docs.length === 0) continue;
    pending.push({ file: rel, docs });
    for (const d of docs) {
      if (d.kind === "ConfigMap") {
        const data = asMap(d.doc.data) ?? {};
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(data)) if (typeof v === "string") flat[k] = v;
        configMaps.set(d.name, { ...(configMaps.get(d.name) ?? {}), ...flat });
      }
    }
  }

  for (const { file, docs } of pending) {
    const group: RawService[] = [];
    const workloadsByFile: Array<{ name: string; labels: YamlMap }> = [];

    for (const { kind, name, doc } of docs) {
      if (!WORKLOAD_KINDS.has(kind)) continue;
      const spec = podSpec(kind, doc);
      const containers = asList(spec?.containers).map(asMap).filter((c): c is YamlMap => !!c);
      if (containers.length === 0) continue;

      const env: Record<string, string> = {};
      let image: string | undefined;
      let entrypoint: string | undefined;
      for (const c of containers) {
        const ref = asString(c.image);
        if (isImageRef(ref)) image ??= ref;
        entrypoint ??= [...asList(c.command), ...asList(c.args)]
          .filter((x): x is string => typeof x === "string")
          .join(" ") || undefined;
        for (const ref of configMapRefs(c)) {
          for (const [k, v] of Object.entries(configMaps.get(ref) ?? {})) env[k] ??= v;
        }
        for (const [k, v] of Object.entries(containerEnv(c))) env[k] = v;
      }

      group.push({ name, file, image, entrypoint, env, dependsOn: [] });
      workloadsByFile.push({ name, labels: podLabels(kind, doc) });
    }

    // Ingress: the cluster's front door — one proxy node + an http edge per
    // backend service its rules route to (v1 `backend.service.name`, with the
    // v1beta1 `backend.serviceName` fallback).
    for (const { kind, name, doc } of docs) {
      if (kind !== "Ingress") continue;
      const backends = new Set<string>();
      let host: string | undefined;
      for (const rule of asList(dig(doc, "spec", "rules"))) {
        const r = asMap(rule);
        host ??= asString(r?.host);
        for (const p of asList(dig(r, "http", "paths"))) {
          const backend = asMap(dig(asMap(p), "backend"));
          const svc =
            asString(dig(backend, "service", "name")) ?? asString(backend?.serviceName);
          if (svc) backends.add(svc);
        }
      }
      const def = asMap(dig(doc, "spec", "defaultBackend"));
      const defSvc = asString(dig(def, "service", "name")) ?? asString(def?.serviceName);
      if (defSvc) backends.add(defSvc);
      if (backends.size === 0) continue;
      group.push({ name, file, env: {}, dependsOn: [] });
      for (const to of backends) ingressEdges.push({ from: name, to, host });
    }

    // Service → workload aliases: every selector entry must match a pod label.
    for (const { kind, name, doc } of docs) {
      if (kind !== "Service") continue;
      const selector = asMap(dig(doc, "spec", "selector"));
      if (!selector) continue;
      const entries = Object.entries(selector).filter(([, v]) => typeof v === "string");
      if (entries.length === 0) continue;
      const target = workloadsByFile.find(({ labels }) =>
        entries.every(([k, v]) => labels[k] === v),
      );
      if (target && target.name !== name) aliases.set(name, target.name);
    }

    if (group.length > 0) {
      files.push(file);
      groups.push(group);
    }
  }

  // Cross-file Service aliases: selectors and workloads often live in separate
  // manifests — retry unresolved Services against ALL workloads.
  const allWorkloads: Array<{ name: string; labels: YamlMap }> = [];
  for (const { docs } of pending) {
    for (const { kind, name, doc } of docs) {
      if (WORKLOAD_KINDS.has(kind)) allWorkloads.push({ name, labels: podLabels(kind, doc) });
    }
  }
  for (const { docs } of pending) {
    for (const { kind, name, doc } of docs) {
      if (kind !== "Service" || aliases.has(name)) continue;
      const selector = asMap(dig(doc, "spec", "selector"));
      if (!selector) continue;
      const entries = Object.entries(selector).filter(([, v]) => typeof v === "string");
      if (entries.length === 0) continue;
      const target = allWorkloads.find(({ labels }) => entries.every(([k, v]) => labels[k] === v));
      if (target && target.name !== name) aliases.set(name, target.name);
    }
  }

  return groups.length > 0 ? { files, groups, aliases, ingressEdges } : undefined;
}
