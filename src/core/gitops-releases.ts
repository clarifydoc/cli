import { readFile } from "fs/promises";
import { join, posix, resolve } from "path";
import { glob } from "./glob.js";
import { byOrdinal } from "./ordinal.js";
import { parseSimpleYaml, projectOfContext, type YamlMap, type YamlValue } from "./deployment.js";
import type { CiDeploy, SubProject } from "../types/analysis.js";

/**
 * Deploys a GitOps controller makes from the repository, as deploy rows beside
 * the CI pipelines' (`ciDeploys`): no pipeline runs them — a controller syncs
 * what the repository declares.
 *
 *  - Flux `HelmRelease` (helm.toolkit.fluxcd.io): `spec.chart.spec` names the
 *    chart, its source and version;
 *  - Argo CD `Application` (argoproj.io): each source a Helm release when it
 *    names a `chart` or has `helm:` settings, else manifests at `path`;
 *  - kustomize `helmCharts:` entries in a kustomization;
 *  - Terraform `helm_release` resources.
 *
 * A chart in the repository (`./charts/orders`, an Argo `path`) is the row's
 * `path`, and with it the sub-project it ships; a chart from a registry is
 * named in `via`.
 */

const str = (v: YamlValue | undefined): string | undefined => (typeof v === "string" && v ? v : undefined);
const map = (v: YamlValue | undefined): YamlMap | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as YamlMap) : undefined);
const list = (v: YamlValue | undefined): YamlValue[] => (Array.isArray(v) ? v : []);

/** A chart reference that is a path in this repository, as a repo-relative path from `file`. */
function localChart(chart: string | undefined, file: string): string | undefined {
  if (!chart || !/^\.{0,2}\//.test(chart) && !/^charts?\//.test(chart)) return undefined;
  return posix.normalize(chart.startsWith(".") ? posix.join(posix.dirname(file), chart) : chart).replace(/\/$/, "");
}

function rowsOfYaml(file: string, text: string): CiDeploy[] {
  const out: CiDeploy[] = [];
  let offset = 0;
  for (const chunk of text.split(/^---\s*$/m)) {
    const line = text.slice(0, offset).split("\n").length + (chunk.startsWith("\n") ? 1 : 0);
    offset += chunk.length + 3;
    if (!/\b(HelmRelease|Application|helmCharts)\b/.test(chunk)) continue;
    let doc: YamlMap;
    try {
      doc = parseSimpleYaml(chunk);
    } catch {
      continue;
    }
    const kind = str(doc.kind);
    const api = str(doc.apiVersion) ?? "";
    const name = str(map(doc.metadata)?.name) ?? "";
    if (kind === "HelmRelease" && /fluxcd\.io/.test(api)) {
      const spec = map(doc.spec);
      const chartSpec = map(map(spec?.chart)?.spec);
      const chart = str(chartSpec?.chart);
      const source = map(chartSpec?.sourceRef);
      const version = str(chartSpec?.version);
      const ns = str(spec?.targetNamespace) ?? str(map(doc.metadata)?.namespace);
      // From a GitRepository, the chart path is relative to the repository's root, not to this file.
      const path = str(source?.kind) === "GitRepository" && chart ? posix.normalize(chart).replace(/^\.\//, "").replace(/\/$/, "") : localChart(chart, file);
      out.push({
        file, provider: "flux", job: str(spec?.releaseName) ?? name, line, triggers: ["gitops sync"], kind: "helm",
        ...(path ? { path } : {}),
        via: `HelmRelease ${name}: chart ${chart ?? "?"}${version ? ` ${version}` : ""}${source ? ` from ${str(source.kind) ?? ""} ${str(source.name) ?? ""}`.trimEnd() : ""}${ns ? ` into ${ns}` : ""}`,
      });
    } else if (kind === "Application" && /argoproj\.io/.test(api)) {
      const spec = map(doc.spec);
      const sources = [map(spec?.source), ...list(spec?.sources).map(map)].filter((x): x is YamlMap => !!x);
      const ns = str(map(spec?.destination)?.namespace);
      for (const src of sources) {
        const chart = str(src.chart);
        const path = str(src.path);
        const helm = chart !== undefined || src.helm !== undefined;
        const revision = str(src.targetRevision);
        out.push({
          file, provider: "argo", job: name, line, triggers: ["gitops sync"], kind: helm ? "helm" : "kubernetes",
          ...(path && !chart ? { path: posix.normalize(path).replace(/^\.\//, "").replace(/\/$/, "") || "." } : {}),
          via: `Application ${name}: ${chart ? `chart ${chart}${revision ? ` ${revision}` : ""} from ${str(src.repoURL) ?? "?"}` : `${path ?? "."} at ${str(src.repoURL) ?? "?"}${revision ? ` ${revision}` : ""}`}${ns ? ` into ${ns}` : ""}`,
        });
      }
    } else if (/(^|\/)kustomization\.ya?ml$/.test(file)) {
      for (const entry of list(doc.helmCharts).map(map)) {
        if (!entry) continue;
        const chart = str(entry.name);
        const version = str(entry.version);
        out.push({
          file, provider: "kustomize", job: str(entry.releaseName) ?? chart ?? "helm", line, triggers: ["kustomize build"], kind: "helm",
          via: `helmCharts ${chart ?? "?"}${version ? ` ${version}` : ""}${str(entry.repo) ? ` from ${str(entry.repo)}` : ""}${str(entry.namespace) ? ` into ${str(entry.namespace)}` : ""}`,
        });
      }
    }
  }
  return out;
}

/** `resource "helm_release" "x" { name = "…" chart = "…" … }` — the block's flat attributes, by a brace count. */
function rowsOfTerraform(file: string, text: string): CiDeploy[] {
  const out: CiDeploy[] = [];
  for (const m of text.matchAll(/resource\s+"helm_release"\s+"([\w-]+)"\s*\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    const body = text.slice(m.index! + m[0].length, i - 1);
    const attr = (k: string) => new RegExp(String.raw`^\s*${k}\s*=\s*"([^"]*)"`, "m").exec(body)?.[1];
    const chart = attr("chart");
    const path = localChart(chart, file);
    out.push({
      file, provider: "terraform", job: attr("name") ?? m[1]!, line: text.slice(0, m.index).split("\n").length, triggers: ["terraform apply"], kind: "helm",
      ...(path ? { path } : {}),
      via: `helm_release ${m[1]}: chart ${chart ?? "?"}${attr("version") ? ` ${attr("version")}` : ""}${attr("repository") ? ` from ${attr("repository")}` : ""}${attr("namespace") ? ` into ${attr("namespace")}` : ""}`,
    });
  }
  return out;
}

export async function detectGitopsReleases(projectRoot: string, subProjects: readonly SubProject[]): Promise<CiDeploy[]> {
  const absRoot = resolve(projectRoot);
  const files = (await glob(["**/*.{yml,yaml}", "**/*.tf"], {
    cwd: absRoot,
    absolute: false,
    deep: 6,
    ignore: ["**/node_modules/**", "**/vendor/**", "**/.git/**", "**/.terraform/**", "**/.github/**"],
  })).map((f) => f.split("\\").join("/")).sort(byOrdinal).slice(0, 1000);
  const out: CiDeploy[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(absRoot, file), "utf8");
    } catch {
      continue;
    }
    if (text.length > 1_000_000) continue;
    if (file.endsWith(".tf")) {
      if (text.includes("helm_release")) out.push(...rowsOfTerraform(file, text));
    } else if (/kind:\s*(?:HelmRelease|Application)\b|^helmCharts:/m.test(text)) out.push(...rowsOfYaml(file, text));
  }
  for (const d of out) {
    if (!d.path) continue;
    const project = projectOfContext(d.path === "." ? "" : d.path, subProjects);
    if (project) d.project = project;
  }
  return out;
}
