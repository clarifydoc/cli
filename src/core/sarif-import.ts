import { isAbsolute, relative, resolve } from "path";
import type { SecurityCategory, SecurityIssue, SecuritySeverity } from "../types/analysis.js";

/**
 * Findings other tools wrote as SARIF — Semgrep, CodeQL, gosec, Bandit,
 * Checkov, anything that emits SARIF 2.1 — joined to the map: each result on
 * a file the analysis knows becomes a `SecurityIssue` tagged with its tool and
 * rule, so the entries pass can say which routes reach it ("reachable from
 * POST /orders"), exactly as for ClarifyDoc's own findings. A result on a
 * file the analysis did not read is counted, not kept.
 */

/** CWE → the category ClarifyDoc's own findings of that weakness carry. */
const CWE_CATEGORY: Record<string, SecurityCategory> = {
  "CWE-89": "sql-injection",
  "CWE-564": "sql-injection",
  "CWE-79": "xss",
  "CWE-80": "xss",
  "CWE-78": "command-injection",
  "CWE-77": "command-injection",
  "CWE-22": "path-traversal",
  "CWE-23": "path-traversal",
  "CWE-918": "ssrf",
  "CWE-601": "open-redirect",
  "CWE-502": "deserialization",
  "CWE-611": "xxe",
  "CWE-798": "hardcoded-secret",
  "CWE-259": "hardcoded-secret",
  "CWE-327": "weak-crypto",
  "CWE-328": "weak-crypto",
  "CWE-94": "eval-exec",
  "CWE-95": "eval-exec",
  "CWE-862": "missing-auth",
  "CWE-306": "missing-auth",
};

export interface SarifImport {
  issues: SecurityIssue[];
  /** Per tool: results read, and how many landed on an analyzed file. */
  tools: Array<{ tool: string; results: number; matched: number }>;
}

interface SarifResult {
  ruleId?: string;
  rule?: { id?: string };
  level?: string;
  message?: { text?: string; markdown?: string };
  locations?: Array<{ physicalLocation?: SarifPhysical }>;
  codeFlows?: Array<{ threadFlows?: Array<{ locations?: Array<{ location?: { physicalLocation?: SarifPhysical; message?: { text?: string } } }> }> }>;
  properties?: Record<string, unknown>;
}
type SarifPhysical = { artifactLocation?: { uri?: string; uriBaseId?: string }; region?: { startLine?: number; snippet?: { text?: string } } };

interface SarifRule {
  id?: string;
  name?: string;
  shortDescription?: { text?: string };
  defaultConfiguration?: { level?: string };
  properties?: { tags?: unknown[]; ["security-severity"]?: unknown; precision?: string; cwe?: unknown };
}

/** SARIF's `level` and CodeQL's numeric `security-severity`, as ClarifyDoc's severities. */
function severityOf(level: string | undefined, securitySeverity: unknown): SecuritySeverity {
  const n = typeof securitySeverity === "string" || typeof securitySeverity === "number" ? Number(securitySeverity) : NaN;
  if (Number.isFinite(n)) return n >= 9 ? "critical" : n >= 7 ? "high" : n >= 4 ? "medium" : "low";
  return level === "error" ? "high" : level === "warning" ? "medium" : "low";
}

function cweOf(...sources: unknown[]): string | undefined {
  for (const s of sources) {
    const text = Array.isArray(s) ? s.join(" ") : typeof s === "string" ? s : "";
    const m = /CWE[-_:\s]?0*(\d+)/i.exec(text);
    if (m) return `CWE-${m[1]}`;
  }
  return undefined;
}

/** A SARIF artifact URI as a project-relative posix path, or null when it lies outside the project. */
function relPath(uri: string, base: string | undefined, projectRoot: string): string | null {
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  if (base && !isAbsolute(p)) p = resolve(base, p);
  const rel = isAbsolute(p) ? relative(projectRoot, p) : p.replace(/^\.\//, "");
  const posix = rel.split("\\").join("/");
  return posix.startsWith("../") || posix === ".." ? null : posix;
}

/** The first thread flow of a result, as the steps a finding carries (in-project steps only). */
function flowOf(
  r: SarifResult,
  file: string,
  rel: (uri: string, base: string | undefined) => string | null,
  knownFiles: ReadonlySet<string>,
): { flow?: NonNullable<SecurityIssue["flow"]> } {
  const steps: NonNullable<SecurityIssue["flow"]> = [];
  for (const l of r.codeFlows?.[0]?.threadFlows?.[0]?.locations ?? []) {
    const p = l.location?.physicalLocation;
    const uri = p?.artifactLocation?.uri;
    const at = uri ? rel(uri, p?.artifactLocation?.uriBaseId) : null;
    if (!at || !knownFiles.has(at)) continue;
    steps.push({ line: Math.max(1, p?.region?.startLine ?? 1), note: (l.location?.message?.text ?? "").replace(/\s+/g, " ").slice(0, 200), ...(at !== file ? { file: at } : {}) });
  }
  return steps.length > 1 ? { flow: steps } : {};
}

export function importSarif(text: string, projectRoot: string, knownFiles: ReadonlySet<string>): SarifImport {
  let log: { runs?: unknown[] };
  try {
    log = JSON.parse(text);
  } catch (e) {
    throw new Error(`not SARIF (JSON): ${(e as Error).message}`);
  }
  if (!Array.isArray(log.runs)) throw new Error("not SARIF: no `runs`");
  const issues: SecurityIssue[] = [];
  const tools: SarifImport["tools"] = [];
  for (const run of log.runs as Array<{ tool?: { driver?: { name?: string; rules?: SarifRule[] } }; results?: SarifResult[]; originalUriBaseIds?: Record<string, { uri?: string }> }>) {
    const tool = (run.tool?.driver?.name ?? "unknown").trim() || "unknown";
    const rules = new Map((run.tool?.driver?.rules ?? []).filter((r) => r.id).map((r) => [r.id!, r]));
    const bases = Object.fromEntries(Object.entries(run.originalUriBaseIds ?? {}).map(([k, v]) => [k, v.uri ? decodeURIComponent(v.uri.replace(/^file:\/\//, "")) : undefined]));
    let matched = 0;
    const results = run.results ?? [];
    for (const r of results) {
      const loc = r.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      if (!uri) continue;
      const file = relPath(uri, loc?.artifactLocation?.uriBaseId ? bases[loc.artifactLocation.uriBaseId] : undefined, projectRoot);
      if (!file || !knownFiles.has(file)) continue;
      matched++;
      const ruleId = r.ruleId ?? r.rule?.id ?? "rule";
      const rule = rules.get(ruleId);
      const cwe = cweOf(rule?.properties?.cwe, rule?.properties?.tags, r.properties?.cwe, ruleId);
      issues.push({
        category: (cwe && CWE_CATEGORY[cwe]) || "external",
        severity: severityOf(r.level ?? rule?.defaultConfiguration?.level, rule?.properties?.["security-severity"] ?? r.properties?.["security-severity"]),
        message: (r.message?.text ?? rule?.shortDescription?.text ?? ruleId).replace(/\s+/g, " ").slice(0, 500),
        filePath: file,
        line: Math.max(1, loc?.region?.startLine ?? 1),
        snippet: (loc?.region?.snippet?.text ?? "").trim().slice(0, 200),
        ...(cwe ? { cwe } : {}),
        ...flowOf(r, file, (u, b) => relPath(u, b ? bases[b] : undefined, projectRoot), knownFiles),
        tool,
        ruleId,
      });
    }
    tools.push({ tool, results: results.length, matched });
  }
  return { issues, tools };
}
