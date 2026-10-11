import { glob } from "./glob.js";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import {
  IGNORE,
  NON_RUNTIME_RE,
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
}

/** `a.b.c` path into the values map; scalars render, structures degrade to "". */
function valuesLookup(values: YamlMap, path: string): string {
  let cur: YamlValue | undefined = values;
  for (const seg of path.split(".")) {
    cur = asMap(cur)?.[seg];
    if (cur === undefined) return "";
  }
  return typeof cur === "string" ? cur : "";
}

/**
 * The text one `{{ … }}` expression renders to; see `renderHelmTemplate` for
 * the handled forms. Anything else renders empty.
 */
function resolveHelmExpr(expr: string, chart: ChartContext | undefined): string {
  const e = expr.trim();

  const vals = e.match(/^\.Values\.([\w.-]+)/);
  if (vals) {
    const resolved = chart ? valuesLookup(chart.values, vals[1]!) : "";
    if (resolved) return resolved;
    // `.Values.x | default "y"` — fall back to the literal default.
    const def = e.match(/\bdefault\s+"([^"]*)"/);
    return def?.[1] ?? "";
  }

  // {{ include "myapp.fullname" . }} / {{ template "myapp.name" . }}
  const inc = e.match(/^(?:include|template)\s+"([^"]+)"/);
  if (inc) return chart?.name ?? inc[1]!.split(".")[0]!;

  if (/^\.Release\.Name\b/.test(e) || /^\.Chart\.Name\b/.test(e)) {
    return chart?.name ?? "";
  }

  return "";
}

/** Lines that are pure template control flow — no YAML content survives them. */
const HELM_CONTROL_RE = /^\{\{-?\s*(if|else|end|range|with|define)\b[^}]*-?\}\}$/;

/**
 * Best-effort rendering of a Helm template into plain YAML.
 *
 * Lines that are only control flow (`{{ if }}`, `{{ range }}`, `{{ end }}`, …)
 * are dropped; `{{ .Values.x }}` reads the values file (or the `| default`
 * literal), `{{ include "x.fullname" . }}`/`.Release.Name`/`.Chart.Name` become
 * the chart name, and anything else renders as an empty string. Good enough to
 * recover images, env and ports; never a full Go-template engine.
 *
 * @param text - The template source
 * @param chart - The chart context, or undefined when no Chart.yaml was found
 * @returns YAML text for `parseSimpleYaml`
 */
export function renderHelmTemplate(text: string, chart: ChartContext | undefined): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (HELM_CONTROL_RE.test(trimmed)) continue;
    out.push(raw.replace(/\{\{-?\s*([^{}]*?)\s*-?\}\}/g, (_, expr: string) => resolveHelmExpr(expr, chart)));
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
      charts.set(dir, { name: asString(chartDoc.name) ?? dir.split("/").pop() ?? "chart", values });
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
        image ??= asString(c.image);
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
