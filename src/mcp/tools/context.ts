/** Shared plumbing for the tool implementations. */

import type { ProjectAnalysis } from "../../types/analysis.js";
import { assessFreshness } from "../../core/manifest.js";
import { AnalysisStore, resolveFilePath, type LoadedAnalysis } from "../store.js";
import { ago, countMap, facts, tally } from "../format.js";

export interface ToolContext {
  store: AnalysisStore;
}

/** The loaded analysis, or a thrown message the model can act on. */
export async function requireAnalysis(ctx: ToolContext): Promise<LoadedAnalysis> {
  return ctx.store.load();
}

/**
 * Resolve a caller-supplied path against the analysis. Ambiguous or unknown
 * paths throw with the near misses listed — the model's next call then has the
 * exact path instead of guessing again.
 */
export function mustResolveFile(loaded: LoadedAnalysis, query: string): string {
  const { path, candidates } = resolveFilePath(loaded.index, loaded.summary.projectRoot, query);
  if (path) return path;
  if (candidates.length === 0) {
    throw new Error(
      `No analyzed file matches "${query}". Paths are project-relative (e.g. src/api/users.ts). ` +
        `Use clarifydoc_search to find one.`,
    );
  }
  throw new Error(
    `"${query}" matches ${candidates.length} files — pass one of:\n` +
      candidates.map((c) => `  ${c}`).join("\n"),
  );
}

export function projectName(summary: ProjectAnalysis): string {
  const root = (summary.projectRoot ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  return root.split("/").pop() || root || "project";
}

/**
 * Whether the analysis still describes the source on disk. Wall-clock age
 * ("analyzed 3 hours ago") says nothing about whether the code moved, and the
 * manifest already carries an mtime and a hash per file, so this is the answer
 * the caller actually needs before deciding to re-analyze.
 */
async function sourceFreshness(store: AnalysisStore): Promise<string | undefined> {
  const f = await assessFreshness(store.analysisDir, store.projectRoot);
  switch (f.state) {
    case "fresh":
      return `unchanged since the analysis (${f.checked} files checked)`;
    case "changed": {
      const parts = [
        f.changed.length ? `${f.changed.length} changed` : "",
        f.removed.length ? `${f.removed.length} removed` : "",
      ].filter(Boolean);
      const eg = [...f.changed, ...f.removed].slice(0, 3).join(", ");
      return `${parts.join(", ")} since the analysis${eg ? ` (e.g. ${eg})` : ""}${f.sampled ? ", sampled" : ""} — call clarifydoc_analyze`;
    }
    case "extractor-changed":
      return "the extractor changed since this analysis — call clarifydoc_analyze with full=true";
    default:
      return undefined; // no manifest: nothing to compare against
  }
}

/**
 * The one-screen overview every session should start from: what was analyzed,
 * how stale it is, and how much of each dimension exists — so the model knows
 * which follow-up tool is worth calling.
 */
export async function statusReport(loaded: LoadedAnalysis, store: AnalysisStore): Promise<string> {
  const { summary } = loaded;
  const routes = summary.routeMap ?? [];
  const apiRoutes = routes.filter((r) => r.kind === "api");
  const frontendRoutes = routes.filter((r) => r.kind === "frontend");
  const security = summary.securityIssues ?? [];
  const severities = tally(security, (s) => s.severity);
  const health = summary.healthScore;

  const lines: string[] = [
    `# ClarifyDoc — ${projectName(summary)}`,
    facts([
      ["root", summary.projectRoot],
      ["analyzed", `${summary.analyzedAt} (${ago(summary.analyzedAt)})`],
      ["source", await sourceFreshness(store)],
      ["files", summary.files.length],
      ["health", health ? `${health.score}/100 (${health.grade})` : undefined],
    ]),
    "",
  ];

  const frameworks = summary.detectedFrameworks ?? [];
  if (frameworks.length) {
    lines.push(
      `frameworks: ${frameworks
        .slice(0, 14)
        .map((f) => f.name)
        .join(", ")}${frameworks.length > 14 ? `, +${frameworks.length - 14} more` : ""}`,
    );
  }
  const subProjects = summary.subProjects ?? [];
  if (subProjects.length > 1) {
    lines.push(
      `sub-projects (${subProjects.length}): ${subProjects
        .slice(0, 8)
        .map((p) => `${p.name} [${p.kind}] ${p.root || "."}`)
        .join(" · ")}${subProjects.length > 8 ? " · …" : ""}`,
    );
  }

  lines.push(
    "",
    `map: ${countMap(
      {
        "api routes": apiRoutes.length,
        "frontend routes": frontendRoutes.length,
        screens: (summary.screens ?? []).length,
        "outbound api calls": (summary.apiCalls ?? []).length,
        "frontend→backend links": (summary.apiRouteLinks ?? []).length,
        "call traces": (summary.symbolLinks ?? []).length,
        entities: (summary.entityGraph?.nodes ?? []).length,
        "er relations": (summary.entityGraph?.edges ?? []).length,
        "data flows": (summary.dataFlows ?? []).length,
        migrations: (summary.migrations ?? []).length,
        "external packages": (summary.externalPackages ?? []).length,
      },
      // Keep the tier order (routes → screens → links → data), not size order.
      { sort: false },
    )}`,
  );
  lines.push(
    `findings: ${
      countMap({
        security: security.length,
        "layer violations": (summary.layerViolations ?? []).length,
        "duplicate groups": (summary.duplicates ?? []).length,
        hotspots: (summary.hotspots ?? []).length,
        suggestions: (summary.suggestions ?? []).length,
        "unused files": (summary.unusedFiles ?? []).length,
      }) || "none"
    }`,
  );
  if (security.length) {
    lines.push(`security by severity: ${countMap(severities)}`);
  }
  if (summary.lspStats) {
    lines.push(
      summary.lspStats.stale
        ? `lsp: stale — the enhancement predates this analysis and was not applied; run \`clarifydoc lsp-update\` to refresh it`
        : `lsp: ${summary.lspStats.serversUsed.join(", ") || "none"} (${summary.lspStats.lspResolvedCount} extra links)`,
    );
  }
  lines.push("", `analysis dir: ${store.analysisDir}`);
  // A project with no frameworks or sub-projects would otherwise leave a gap.
  return lines.filter((line, i) => line !== "" || lines[i - 1] !== "").join("\n");
}
