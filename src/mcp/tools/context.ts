/** Shared plumbing for the tool implementations. */

import type { ProjectAnalysis } from "../../types/analysis.js";
import { assessFreshness, type FreshnessReport } from "../../core/manifest.js";
import { AnalysisStore, resolveFilePath, type LoadedAnalysis } from "../store.js";
import { ago, countMap, facts, plural, tally } from "../format.js";
import { STATUS_HINT } from "../empty.js";

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
      return `unchanged since the analysis (${f.checked} files checked${f.head ? `; HEAD moved to ${f.head.now.slice(0, 8)} without touching them` : ""})`;
    case "changed": {
      const eg = [...f.changed, ...f.added, ...f.removed].slice(0, 3).join(", ");
      return `${changeSummary(f)} since the analysis${eg ? ` (e.g. ${eg})` : ""}${f.sampled ? ", sampled" : ""} — call clarifydoc_analyze`;
    }
    case "extractor-changed":
      return "the extractor changed since this analysis — call clarifydoc_analyze with full=true";
    default:
      return undefined; // no manifest: nothing to compare against
  }
}

/**
 * The `Next:` suggestion for a result that came back empty.
 *
 * "Maybe nothing is analyzed" is the question behind most empty results, and
 * naming `clarifydoc_status` only delegates it. The manifest can answer it
 * here for the price of a few hundred stats — and an empty result is a rare
 * enough path to afford them, which is why this is called from misses and not
 * from every call. The stat budget is deliberately a tenth of the status
 * report's: a hint may be sampled, a status line should not be.
 */
export async function stalenessHint(store: AnalysisStore): Promise<string> {
  let report;
  try {
    report = await assessFreshness(store.analysisDir, store.projectRoot, { maxStats: 500 });
  } catch {
    return STATUS_HINT;
  }
  if (report.state === "extractor-changed") {
    return "clarifydoc_analyze full=true — the extractor changed since this analysis";
  }
  if (report.state === "changed") {
    return `clarifydoc_analyze — ${changeSummary(report)} since the analysis${report.sampled ? " (sampled)" : ""}`;
  }
  return STATUS_HINT;
}

/** "3 changed, 1 added, 2 removed" — the parts that are non-zero, HEAD's move last. */
export function changeSummary(f: FreshnessReport): string {
  return [
    f.changed.length ? `${f.changed.length} changed` : "",
    f.added.length ? `${f.added.length} added` : "",
    f.removed.length ? `${f.removed.length} removed` : "",
    f.head ? `HEAD ${f.head.analyzed.slice(0, 8)} → ${f.head.now.slice(0, 8)}` : "",
  ].filter(Boolean).join(", ");
}

/**
 * The line every answer ends with while the analysis no longer describes the
 * source: what moved, and how to refresh. Null while it is fresh, or when
 * nothing can be compared (no manifest). Checked at most every few seconds,
 * so a burst of calls costs one stat pass.
 */
export function freshnessBanner(store: AnalysisStore, ttlMs = 10_000): () => Promise<string | null> {
  let at = 0;
  let last: Promise<string | null> = Promise.resolve(null);
  return () => {
    if (Date.now() - at < ttlMs) return last;
    at = Date.now();
    last = assessFreshness(store.analysisDir, store.projectRoot, { maxStats: 2000 })
      .then((f) => {
        if (f.state === "extractor-changed") return `⚠ Stale: the extractor changed since this analysis — ${store.allowAnalyze ? "clarifydoc_analyze full=true" : "re-run `clarifydoc analyze`"} refreshes it.`;
        if (f.state !== "changed") return null;
        return `⚠ Stale: ${changeSummary(f)} since this analysis — ${store.allowAnalyze ? "clarifydoc_analyze" : "re-run `clarifydoc analyze --incremental`"} refreshes it.`;
      })
      .catch(() => null);
    return last;
  };
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
      ["commit", summary.sourceRevision ? `${summary.sourceRevision.commit.slice(0, 12)}${summary.sourceRevision.branch ? ` on ${summary.sourceRevision.branch}` : ""}${summary.sourceRevision.dirty ? `, ${plural(summary.sourceRevision.dirty, "uncommitted file")}` : ""}` : undefined],
      ["source", await sourceFreshness(store)],
      ["files", summary.files.length],
      ["health", health ? `${health.score}/100 (${health.grade})` : undefined],
    ]),
    "",
  ];

  const prov = summary.provenance;
  if (prov) {
    lines.push(
      `signals: extractor ${prov.extractorVersion} · lsp ${prov.signals.lsp} · git history ${prov.signals.gitHistory}` +
        (prov.signals.gitSkipReason ? ` (${prov.signals.gitSkipReason})` : "") +
        (prov.parseFallbacks ? ` · parse fallbacks ${Object.values(prov.parseFallbacks).reduce((a, b) => a + b, 0)}` : ""),
    );
    // Config problems were verbose-console only, i.e. invisible to exactly the
    // people who configure a project and then analyze it from an editor.
    if (prov.config.warnings.length) {
      lines.push(
        ...prov.config.warnings.slice(0, 5).map((w) => `config warning: ${w}`),
        ...(prov.config.warnings.length > 5 ? [`config warning: +${prov.config.warnings.length - 5} more`] : []),
      );
    }
    lines.push("");
  }

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
        "frontend→backend links": (summary.apiRouteLinks ?? []).filter((l) => !l.sourceRole).length,
        "links from tests": (summary.apiRouteLinks ?? []).filter((l) => l.sourceRole === "test").length,
        "project dependencies": (summary.projectDependencies ?? []).length,
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
        "unreachable files": summary.deadCode?.files.length ?? 0,
        "unused exports": summary.deadCode?.exports.length ?? 0,
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
