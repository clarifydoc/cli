/** Project-level tools: status, (re-)analyze, search, health, git impact. */

import type { McpTool } from "../protocol.js";
import type { LoadedAnalysis } from "../store.js";
import {
  ago,
  bulletList,
  cap,
  contains,
  enumArg,
  facts,
  joinLines,
  loc,
  numberArg,
  requiredStringArg,
  routeLabel,
  section,
  stringArg,
  stringArrayArg,
  tally,
  countMap,
  booleanArg,
} from "../format.js";
import { projectName, requireAnalysis, statusReport, type ToolContext } from "./context.js";

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

export function statusTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_status",
    title: "ClarifyDoc analysis status",
    description:
      "Start here. Reports what ClarifyDoc has mapped for this project: root, when it was last analyzed, " +
      "detected frameworks, sub-projects, and how many routes, screens, frontend→backend links, call traces, " +
      "entities, data flows and findings exist. Use it to decide which other clarifydoc_* tool to call.",
    inputSchema: NO_ARGS,
    handler: async () => {
      if (!(await ctx.store.exists()) && !ctx.store.allowColdStart) {
        return {
          text:
            `No ClarifyDoc analysis exists for ${ctx.store.projectRoot} (expected ${ctx.store.summaryPath}).\n` +
            `This server cannot run one itself. Analyze from VS Code (ClarifyDoc: Analyze Workspace) or the CLI.`,
          isError: true,
        };
      }
      const loaded = await requireAnalysis(ctx);
      return { text: statusReport(loaded, ctx.store) };
    },
  };
}

export function analyzeTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_analyze",
    title: "Re-analyze the project",
    description:
      "Re-run the ClarifyDoc static analysis so the other tools see current code. Incremental by default " +
      "(only changed files are re-parsed), so it is cheap to call after edits. Pass full=true to invalidate " +
      "the cache and re-parse everything. This is the only clarifydoc tool that writes anything, and only " +
      "into the analysis directory (.clarifydoc/ by default) — never into your source files.",
    inputSchema: {
      type: "object",
      properties: {
        full: {
          type: "boolean",
          description: "Force a complete re-scan instead of reusing cached per-file results.",
        },
      },
      additionalProperties: false,
    },
    readOnly: false,
    handler: async (args) => {
      const full = booleanArg(args, "full");
      const started = Date.now();
      const result = await ctx.store.refresh({ full });
      const loaded = await requireAnalysis(ctx);
      return {
        text: joinLines([
          `Analysis complete in ${((Date.now() - started) / 1000).toFixed(1)}s (${
            full ? "full re-scan" : "incremental"
          }): ${result.fileCount} files.`,
          "",
          statusReport(loaded, ctx.store),
        ]),
      };
    },
  };
}

type SearchKind = "route" | "screen" | "file" | "symbol" | "entity" | "api-call";
const SEARCH_KINDS: readonly SearchKind[] = ["route", "screen", "file", "symbol", "entity", "api-call"];

interface Hit {
  score: number;
  text: string;
}

/** 3 = exact, 2 = word/segment boundary, 1 = substring, 0 = no match. */
function score(haystack: string | null | undefined, needle: string): number {
  if (!haystack) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 3;
  const index = h.indexOf(n);
  if (index === -1) return 0;
  if (index === 0) return 2;
  return /[^a-z0-9]/.test(h[index - 1] ?? "") ? 2 : 1;
}

function best(...scores: number[]): number {
  return Math.max(0, ...scores);
}

function collect(hits: Hit[], limit: number): string[] {
  hits.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  return bulletList(hits, limit, (h) => h.text);
}

export function searchTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_search",
    title: "Search the code map",
    description:
      "Find things by name across the analysis: API/frontend routes, screens, files, symbols (functions and " +
      "classes), ORM entities/tables, and outbound API calls. Returns path:line references you can open or " +
      "feed to the other clarifydoc tools. Use this when you know a name but not where it lives.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Substring to look for, case-insensitive (route path, screen title, symbol, table, file).",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...SEARCH_KINDS] },
          description: "Restrict the search to these kinds. Default: all.",
        },
        limit: { type: "number", description: "Max results per kind (default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = requiredStringArg(args, "query");
      const limit = numberArg(args, "limit", 8, { max: 100 });
      const requested = stringArrayArg(args, "kinds")
        .map((k) => k.toLowerCase())
        .filter((k): k is SearchKind => (SEARCH_KINDS as readonly string[]).includes(k));
      const kinds = new Set<SearchKind>(requested.length ? requested : SEARCH_KINDS);
      const loaded = await requireAnalysis(ctx);
      const { summary, index } = loaded;
      const blocks: string[][] = [];

      if (kinds.has("route")) {
        const hits: Hit[] = [];
        for (const route of summary.routeMap ?? []) {
          const s = best(score(route.path, query), score(route.handler, query));
          if (s) {
            hits.push({
              score: s,
              text: `${routeLabel(route.httpMethod, route.path)} [${route.kind}]${
                route.handler ? ` → ${route.handler}` : ""
              } (${loc((route as { filePath?: string }).filePath, route.line)})`,
            });
          }
        }
        blocks.push(section(`Routes (${hits.length})`, collect(hits, limit)));
      }

      if (kinds.has("screen")) {
        const hits: Hit[] = [];
        for (const screen of summary.screens ?? []) {
          const s = best(
            score(screen.name, query),
            score(screen.caption, query),
            score(screen.routePath, query),
            score(screen.filePath, query),
          );
          if (s) {
            hits.push({
              score: s,
              text: `${screen.name}${screen.routePath ? ` @ ${screen.routePath}` : ""} (${screen.filePath}) · ${
                screen.components.length
              } components`,
            });
          }
        }
        blocks.push(section(`Screens (${hits.length})`, collect(hits, limit)));
      }

      if (kinds.has("symbol")) {
        const hits: Hit[] = [];
        for (const file of summary.complexity ?? []) {
          for (const fn of file.functions) {
            const s = score(fn.functionName, query);
            if (s) {
              hits.push({
                score: s,
                text: `${fn.functionName}() (${loc(file.filePath, fn.line)}) · complexity ${fn.complexity}`,
              });
            }
          }
        }
        for (const node of summary.classGraph?.nodes ?? []) {
          if (node.isFile || node.isExternal) continue;
          const s = score(node.name, query);
          if (s) {
            hits.push({
              score: s,
              text: `${node.name} ${node.isInterface ? "(interface)" : "(class)"} (${node.filePath}) · refs in ${
                node.inboundCount
              } / out ${node.outboundCount}`,
            });
          }
        }
        blocks.push(section(`Symbols (${hits.length})`, collect(hits, limit)));
      }

      if (kinds.has("entity")) {
        const hits: Hit[] = [];
        for (const node of summary.entityGraph?.nodes ?? []) {
          const columnHit = node.columns.some((c) => score(c.name, query) === 3);
          const s = best(score(node.name, query), columnHit ? 1 : 0);
          if (s) {
            hits.push({
              score: s,
              text: `${node.name} [${node.kind}${node.orm ? `, ${node.orm}` : ""}] (${loc(
                node.filePath,
                node.line,
              )}) · ${node.columns.length} columns${columnHit ? " · column matches query" : ""}`,
            });
          }
        }
        blocks.push(section(`Entities (${hits.length})`, collect(hits, limit)));
      }

      if (kinds.has("api-call")) {
        const hits: Hit[] = [];
        for (const call of summary.apiCalls ?? []) {
          const s = best(score(call.name, query), score(call.target, query));
          if (s) {
            hits.push({
              score: s,
              text: `${call.target ?? call.name} (${loc(
                (call as { filePath?: string }).filePath,
                call.line,
              )})`,
            });
          }
        }
        blocks.push(section(`Outbound API calls (${hits.length})`, collect(hits, limit)));
      }

      if (kinds.has("file")) {
        const hits: Hit[] = [];
        for (const path of index.pathLookup.values()) {
          const s = score(path, query);
          if (s) {
            const f = index.byFile.get(path);
            hits.push({
              score: s,
              text: `${path}${f?.layer ? ` [${f.layer}]` : ""}${
                f?.complexity ? ` · complexity ${f.complexity.totalComplexity}` : ""
              }`,
            });
          }
        }
        blocks.push(section(`Files (${hits.length})`, collect(hits, limit)));
      }

      const body = blocks.filter((b) => b.length > 0);
      if (body.length === 0) {
        return {
          text: `No matches for "${query}" in ${projectName(summary)} (${summary.files.length} files analyzed).`,
        };
      }
      return { text: joinLines([`# Search: "${query}"`, "", ...body]) };
    },
  };
}

type HealthCategory =
  | "security"
  | "layers"
  | "complexity"
  | "duplicates"
  | "hotspots"
  | "suggestions"
  | "patterns"
  | "unused";
const HEALTH_CATEGORIES: readonly HealthCategory[] = [
  "security",
  "layers",
  "complexity",
  "duplicates",
  "hotspots",
  "suggestions",
  "patterns",
  "unused",
];

export function healthTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_health",
    title: "Code health findings",
    description:
      "The project's health score and the findings behind it: security issues, architecture layer violations, " +
      "high-complexity functions, duplicate code, churn×complexity hotspots, generated dead code, detected " +
      "patterns and actionable suggestions. Call with no category for the summary, then drill into one.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...HEALTH_CATEGORIES],
          description: "Drill into one finding category. Omit for the scoreboard plus counts.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Only for category=security or suggestions: minimum severity/priority to include.",
        },
        file: { type: "string", description: "Restrict findings to one file (project-relative path substring)." },
        limit: { type: "number", description: "Max rows (default 25)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      const category = enumArg(args, "category", HEALTH_CATEGORIES);
      const limit = numberArg(args, "limit", 25, { max: 300 });
      const fileFilter = stringArg(args, "file");
      const severity = enumArg(args, "severity", ["critical", "high", "medium", "low"] as const);
      const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      const inFile = (p: string | undefined) => !fileFilter || contains(p, fileFilter);

      if (!category) {
        const health = summary.healthScore;
        const lines: string[] = [
          `# Health — ${projectName(summary)}`,
          health ? `score: ${health.score}/100 (grade ${health.grade})` : "score: not computed",
          "",
        ];
        if (health?.penalties?.length) {
          lines.push("## What costs points", ...bulletList(health.penalties, 12, (p) => `−${p.points} ${p.reason}`), "");
        }
        lines.push(
          "## Findings available",
          ...bulletList(
            [
              ["security", (summary.securityIssues ?? []).length],
              ["layers", (summary.layerViolations ?? []).length],
              ["complexity", (summary.complexity ?? []).reduce((n, c) => n + c.functions.length, 0)],
              ["duplicates", (summary.duplicates ?? []).length],
              ["hotspots", (summary.hotspots ?? []).length],
              ["suggestions", (summary.suggestions ?? []).length],
              ["patterns", (summary.patterns ?? []).length],
              ["unused", (summary.unusedFiles ?? []).length],
            ] as Array<[string, number]>,
            20,
            ([name, count]) => `${name}: ${count}${count ? ` — call with category="${name}"` : ""}`,
          ),
        );
        const severities = tally(summary.securityIssues ?? [], (s) => s.severity);
        if (Object.keys(severities).length) lines.push("", `security by severity: ${countMap(severities)}`);
        return { text: joinLines(lines) };
      }

      switch (category) {
        case "security": {
          const issues = (summary.securityIssues ?? [])
            .filter((i) => inFile(i.filePath))
            .filter((i) => !severity || rank[i.severity] <= rank[severity])
            .sort((a, b) => rank[a.severity] - rank[b.severity]);
          return {
            text: joinLines([
              `# Security issues (${issues.length})`,
              ...bulletList(
                issues,
                limit,
                (i) => `[${i.severity}] ${i.category}: ${i.message} (${loc(i.filePath, i.line)})`,
              ),
            ]),
          };
        }
        case "layers": {
          const violations = (summary.layerViolations ?? []).filter(
            (v) => inFile(v.sourceFile) || inFile(v.targetFile),
          );
          return {
            text: joinLines([
              `# Layer violations (${violations.length})`,
              "A violation is an import that crosses the architecture layers the wrong way.",
              "",
              ...bulletList(
                violations,
                limit,
                (v) =>
                  `${v.sourceLayer} → ${v.targetLayer}: ${loc(v.sourceFile, v.line)} imports ` +
                  `${v.importSpecifier} (${v.targetFile})`,
              ),
            ]),
          };
        }
        case "complexity": {
          const rows = (summary.complexity ?? [])
            .filter((c) => inFile(c.filePath))
            .flatMap((c) => c.functions.map((fn) => ({ ...fn, filePath: c.filePath })))
            .sort((a, b) => b.complexity - a.complexity);
          return {
            text: joinLines([
              `# Most complex functions (${rows.length} total)`,
              ...bulletList(
                rows,
                limit,
                (fn) => `${fn.complexity} — ${fn.functionName}() (${loc(fn.filePath, fn.line)})`,
              ),
            ]),
          };
        }
        case "duplicates": {
          const groups = (summary.duplicates ?? []).filter((g) =>
            g.occurrences.some((o) => inFile(o.filePath)),
          );
          return {
            text: joinLines([
              `# Duplicate groups (${groups.length})`,
              ...bulletList(
                groups,
                limit,
                (g) =>
                  `${g.functionName} [${g.kind}] ×${g.occurrences.length}: ` +
                  g.occurrences
                    .slice(0, 4)
                    .map((o) => loc(o.filePath, o.line))
                    .join(", ") +
                  (g.occurrences.length > 4 ? ", …" : ""),
              ),
            ]),
          };
        }
        case "hotspots": {
          const rows = (summary.hotspots ?? []).filter((h) => inFile(h.file));
          return {
            text: joinLines([
              `# Hotspots (${rows.length}) — churn × complexity`,
              ...bulletList(
                rows,
                limit,
                (h) => `${h.score} — ${h.file} (${h.commits} commits, complexity ${h.totalComplexity})`,
              ),
            ]),
          };
        }
        case "suggestions": {
          const rows = (summary.suggestions ?? [])
            .filter((s) => inFile(s.filePath))
            .filter((s) => !severity || rank[s.priority] <= rank[severity])
            .sort((a, b) => rank[a.priority] - rank[b.priority]);
          return {
            text: joinLines([
              `# Suggestions (${rows.length})`,
              ...bulletList(
                rows,
                limit,
                (s) =>
                  `[${s.priority}] ${s.category}: ${s.message}${s.filePath ? ` (${s.filePath})` : ""}\n    → ${
                    s.actionable
                  }`,
              ),
            ]),
          };
        }
        case "patterns": {
          const rows = (summary.patterns ?? []).filter((p) => inFile(p.filePath));
          return {
            text: joinLines([
              `# Detected patterns (${rows.length})`,
              ...bulletList(
                rows,
                limit,
                (p) => `${p.kind}: ${p.name} (${loc(p.filePath, p.line)}) [${p.confidence}] ${p.detail}`,
              ),
            ]),
          };
        }
        case "unused": {
          const rows = (summary.unusedFiles ?? []).filter((f) => inFile(f));
          return {
            text: joinLines([
              `# Unused generated files (${rows.length})`,
              rows.length
                ? "Files under a detected generated/barrel root that nothing outside that tree imports."
                : "None.",
              "",
              ...bulletList(rows, limit, (f) => f),
            ]),
          };
        }
      }
    },
  };
}

export function impactTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_impact",
    title: "Impact of changed files",
    description:
      "Project a set of changed files onto the analysis: which screens and API routes are affected, which ORM " +
      "entities and queues are touched, which files transitively import the changes, which tests to run, and a " +
      "risk level. Defaults to the working tree vs HEAD (git); pass `files` to skip git entirely.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Explicit changed files, project-relative. Skips git when provided.",
        },
        base: { type: "string", description: "Git ref to diff the working tree against (default HEAD)." },
        staged: { type: "boolean", description: "Use staged changes only (git diff --cached)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const explicit = stringArrayArg(args, "files");
      let changed: string[];
      let label: string;
      if (explicit.length) {
        changed = explicit;
        label = "files argument";
      } else {
        const { gitChangedFiles } = await import("../../core/git-changed-files.js");
        try {
          ({ files: changed, label } = await gitChangedFiles(ctx.store.projectRoot, {
            base: stringArg(args, "base"),
            staged: booleanArg(args, "staged"),
          }));
        } catch (e) {
          return {
            text:
              `Could not read changed files from git: ${(e as Error).message}\n` +
              `Pass \`files\` with the changed paths instead.`,
            isError: true,
          };
        }
      }
      if (changed.length === 0) {
        return { text: `No changed files (${label}) — nothing to project onto the analysis.` };
      }
      const { computeImpactDiff, renderImpactMarkdown } = await import("../../core/impact-diff.js");
      const impact = computeImpactDiff(loaded.summary, changed, { baseLabel: label });
      return {
        text: joinLines([
          renderImpactMarkdown(impact),
          "",
          facts([
            ["analysis age", ago(loaded.summary.analyzedAt)],
            ["unknown to the analysis", impact.unknownFiles.length],
          ]),
          impact.unknownFiles.length
            ? `Not in the analysis (new or unanalyzed): ${cap(impact.unknownFiles, 10).shown.join(", ")}` +
              (impact.unknownFiles.length > 10 ? ` … +${impact.unknownFiles.length - 10}` : "") +
              " — run clarifydoc_analyze to include them."
            : "",
        ]),
      };
    },
  };
}

/** Re-exported for the resource that mirrors `clarifydoc_status`. */
export function statusText(loaded: LoadedAnalysis, ctx: ToolContext): string {
  return statusReport(loaded, ctx.store);
}
