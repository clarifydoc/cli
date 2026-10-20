import { createHash } from "crypto";
import type { ApiRouteLinkStats, ContractFinding, LayerViolation, SecurityCategory, SecurityIssue } from "../types/analysis.js";
import { ruleIdOf as ruleIdFor } from "./security-rules.js";

/**
 * Security findings as SARIF 2.1.0 — what GitHub code scanning and most CI
 * dashboards ingest. One rule per category (`clarifydoc/sql-injection`), tagged
 * with the CWEs its findings carry; one result per finding, located relative
 * to the analyzed root (`%SRCROOT%`), with a fingerprint that survives the
 * finding's line moving (category + file + the masked snippet). TODO/FIXME
 * notes are not findings and are left out.
 */
export function buildSarif(issues: readonly SecurityIssue[], toolVersion: string, extra: readonly StructuralFinding[] = []): SarifLog {
  // A finding imported from another tool's SARIF is that tool's to report.
  const kept = issues.filter((i) => i.category !== "todo-fixme" && !i.tool);
  const rules = new Map<string, SarifRule>();
  for (const issue of kept) {
    const id = ruleIdOf(issue);
    let rule = rules.get(id);
    if (!rule) {
      rule = {
        id,
        name: issue.category,
        shortDescription: { text: TITLES[issue.category] ?? issue.category },
        defaultConfiguration: { level: levelOf(issue) },
        properties: { tags: ["security"] },
      };
      rules.set(id, rule);
    }
    if (issue.cwe) {
      const tag = `external/cwe/${issue.cwe.toLowerCase()}`;
      if (!rule.properties.tags.includes(tag)) rule.properties.tags.push(tag);
    }
    if (rank(levelOf(issue)) > rank(rule.defaultConfiguration.level)) rule.defaultConfiguration.level = levelOf(issue);
  }
  const ordered = [...rules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = new Map(ordered.map((r, i) => [r.id, i]));
  const occurrence = new Map<string, number>();
  const results: SarifResult[] = kept.map((issue) => {
    const base = createHash("sha256").update(`${issue.category}\u0000${issue.filePath}\u0000${issue.snippet.trim()}`).digest("hex").slice(0, 32);
    // Two identical lines in one file are two findings.
    const n = (occurrence.get(base) ?? 0) + 1;
    occurrence.set(base, n);
    const uri = encodeURI(issue.filePath.replace(/\\/g, "/"));
    const at = (line: number, file?: string): SarifLocation => ({ physicalLocation: { artifactLocation: { uri: file ? encodeURI(file.replace(/\\/g, "/")) : uri, uriBaseId: "%SRCROOT%" }, region: { startLine: Math.max(1, line) } } });
    return {
      ruleId: ruleIdOf(issue),
      ruleIndex: index.get(ruleIdOf(issue))!,
      level: levelOf(issue),
      message: { text: issue.cwe ? `${issue.message} (${issue.cwe})` : issue.message },
      locations: [at(issue.line)],
      partialFingerprints: { "clarifydocFinding/v1": `${base}:${n}` },
      properties: { severity: issue.severity },
      ...(issue.flow && issue.flow.length > 1
        ? { codeFlows: [{ threadFlows: [{ locations: issue.flow.map((step) => ({ location: { ...at(step.line, step.file), message: { text: step.note } } })) }] }] }
        : {}),
    };
  });
  // Structural findings: their own rules, after the security ones.
  for (const f of extra) {
    let rule = rules.get(f.ruleId);
    if (!rule) {
      rule = { id: f.ruleId, name: f.ruleId.replace(/^clarifydoc\//, ""), shortDescription: { text: f.title }, defaultConfiguration: { level: f.level }, properties: { tags: [...f.tags] } };
      rules.set(f.ruleId, rule);
      ordered.push(rule);
      index.set(f.ruleId, ordered.length - 1);
    }
    if (rank(f.level) > rank(rule.defaultConfiguration.level)) rule.defaultConfiguration.level = f.level;
    const base = createHash("sha256").update(`${f.ruleId}\u0000${f.file}\u0000${f.fingerprint}`).digest("hex").slice(0, 32);
    const n = (occurrence.get(base) ?? 0) + 1;
    occurrence.set(base, n);
    results.push({
      ruleId: f.ruleId,
      ruleIndex: index.get(f.ruleId)!,
      level: f.level,
      message: { text: f.message },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: encodeURI(f.file.replace(/\\/g, "/")), uriBaseId: "%SRCROOT%" },
          region: { startLine: Math.max(1, f.line) },
        },
      }],
      partialFingerprints: { "clarifydocFinding/v1": `${base}:${n}` },
      properties: { severity: f.level === "error" ? "high" : f.level === "warning" ? "medium" : "low" },
    });
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "ClarifyDoc", informationUri: "https://github.com/clarifydoc/cli", version: toolVersion, rules: ordered } },
      results,
    }],
  };
}

const ruleIdOf = (issue: SecurityIssue): string => ruleIdFor(issue.category as SecurityCategory);

/** A finding of the map rather than of the code's security: a call that reaches no route, an import a rule forbids. */
export interface StructuralFinding {
  ruleId: string;
  /** The rule's one-line title. */
  title: string;
  level: SarifLevel;
  message: string;
  file: string;
  line: number;
  /** What identifies the finding when its line moves (the call's method + URL, the import's target). */
  fingerprint: string;
  tags: readonly string[];
}

/**
 * The structural findings of an analysis: calls that reach no route (a
 * method refused is an error — the client asks for what the server does not
 * serve; the rest are warnings) and imports a team rule or the layer order
 * forbids. Calls are listed up to the summary's own cap.
 */
export function structuralFindings(summary: { apiRouteLinkStats?: ApiRouteLinkStats; layerViolations?: readonly LayerViolation[]; contractFindings?: readonly ContractFinding[] }): StructuralFinding[] {
  const out: StructuralFinding[] = [];
  for (const c of summary.contractFindings ?? []) {
    const call = `${c.method ?? "?"} ${c.url}`;
    const route = `${c.route.path} (${c.route.file}:${c.route.line})`;
    out.push({
      ruleId: `clarifydoc/contract-${c.kind}`,
      title: CONTRACT_TITLES[c.kind],
      // A missing required field or a mistyped one fails the request; an extra one is ignored or rejected.
      // A read of a field the response never has is undefined at runtime — likely a bug, not certainly one.
      level: c.kind === "unknown-field" || c.kind === "unknown-response-field" ? "warning" : "error",
      message: c.kind === "missing-field"
        ? `${call} does not send "${c.field}", which ${route} requires.`
        : c.kind === "unknown-field"
          ? `${call} sends "${c.field}", which ${route} does not declare.`
          : c.kind === "unknown-response-field"
            ? `${call} reads "${c.field}" from the response, which ${route} does not send.`
            : `${call} sends "${c.field}" as ${c.actual}; ${route} declares ${c.expected}.`,
      file: c.file,
      line: c.line,
      fingerprint: `${call} ${c.kind} ${c.field}`,
      tags: ["api-contract"],
    });
  }
  for (const m of summary.apiRouteLinkStats?.misses ?? []) {
    const call = `${m.method ?? "?"} ${m.url}`;
    const served = m.existing?.length ? ` — served as ${m.existing.map((r) => `${r.method ?? "*"} ${r.path} (${r.file}:${r.line})`).join(", ")}` : "";
    out.push({
      ruleId: `clarifydoc/route-${m.reason}`,
      title: ROUTE_MISS_TITLES[m.reason],
      level: m.reason === "method-mismatch" ? "error" : m.reason === "ambiguous-suffix" ? "note" : "warning",
      message: `${call}: ${ROUTE_MISS_TITLES[m.reason].toLowerCase()}${served}`,
      file: m.file,
      line: m.line,
      fingerprint: call,
      tags: ["api-contract"],
    });
  }
  for (const v of summary.layerViolations ?? []) {
    out.push({
      ruleId: v.rule ? "clarifydoc/import-rule" : "clarifydoc/layer-order",
      title: v.rule ? "Import a team rule forbids" : "Import against the layer order",
      level: v.rule ? (v.severity === "warn" ? "warning" : "error") : "warning",
      message: v.rule
        ? `${v.sourceFile} imports ${v.targetFile} (${v.importSpecifier}), which the rule "${v.rule}" forbids.`
        : `${v.sourceLayer} imports ${v.targetLayer}: ${v.sourceFile} → ${v.targetFile} (${v.importSpecifier}).`,
      file: v.sourceFile,
      line: v.line,
      fingerprint: `${v.importSpecifier} ${v.targetFile}`,
      tags: ["architecture"],
    });
  }
  return out;
}

const CONTRACT_TITLES: Record<ContractFinding["kind"], string> = {
  "missing-field": "Request body misses a required field",
  "unknown-field": "Request body sends a field the route does not declare",
  "type-mismatch": "Request body field has the wrong type",
  "unknown-response-field": "Caller reads a response field the route does not send",
};

const ROUTE_MISS_TITLES: Record<NonNullable<ApiRouteLinkStats["misses"]>[number]["reason"], string> = {
  unmatched: "API call reaches no route",
  "method-mismatch": "API call uses a method its route does not serve",
  "origin-mismatch": "API call's service has no such route",
  "ambiguous-suffix": "API call ends like several routes",
};

/** Results at or above a level: what `--fail-on <level>` counts. */
export function resultsAtLeast(log: SarifLog, level: SarifLevel): number {
  return log.runs.reduce((n, run) => n + run.results.filter((r) => rank(r.level) >= rank(level)).length, 0);
}

/** SARIF level: critical/high → error, medium → warning, low → note. */
function levelOf(issue: SecurityIssue): SarifLevel {
  return issue.severity === "critical" || issue.severity === "high" ? "error" : issue.severity === "medium" ? "warning" : "note";
}
const rank = (l: SarifLevel): number => (l === "error" ? 2 : l === "warning" ? 1 : 0);

const TITLES: Partial<Record<SecurityIssue["category"], string>> = {
  "hardcoded-secret": "Hardcoded credential",
  "sql-injection": "SQL built from values",
  xss: "Cross-site scripting sink",
  "eval-exec": "Dynamic code execution",
  "command-injection": "OS command execution",
  "subprocess-shell": "Command run through a shell",
  "debug-statement": "Debug statement left in",
  pickle: "Unsafe deserialization (pickle)",
  deserialization: "Unsafe deserialization",
  xxe: "XML external entities",
  "weak-crypto": "Broken or weak cryptography",
  "bare-except": "Exception swallowed",
  "insecure-config": "Insecure configuration",
  "missing-auth": "Unauthenticated write",
  "path-traversal": "Path traversal",
  ssrf: "Server-side request forgery",
  "open-redirect": "Open redirect",
  "safe-method-write": "GET that writes",
};

export type SarifLevel = "error" | "warning" | "note";
interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { tags: string[] };
}
interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string; uriBaseId: string }; region: { startLine: number } } }>;
  partialFingerprints: Record<string, string>;
  properties: { severity: string };
  /** A taint finding's path from request input to the sink, one thread in its file. */
  codeFlows?: Array<{ threadFlows: Array<{ locations: Array<{ location: SarifLocation & { message: { text: string } } }> }> }>;
}
type SarifLocation = { physicalLocation: { artifactLocation: { uri: string; uriBaseId: string }; region: { startLine: number } } };
/** The SARIF 2.1.0 log `buildSarif` writes (the subset it fills). */
export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<{ tool: { driver: { name: string; informationUri: string; version: string; rules: SarifRule[] } }; results: SarifResult[] }>;
}
