import { createHash } from "crypto";
import type { SecurityIssue } from "../types/analysis.js";

/**
 * Security findings as SARIF 2.1.0 — what GitHub code scanning and most CI
 * dashboards ingest. One rule per category (`clarifydoc/sql-injection`), tagged
 * with the CWEs its findings carry; one result per finding, located relative
 * to the analyzed root (`%SRCROOT%`), with a fingerprint that survives the
 * finding's line moving (category + file + the masked snippet). TODO/FIXME
 * notes are not findings and are left out.
 */
export function buildSarif(issues: readonly SecurityIssue[], toolVersion: string): SarifLog {
  const kept = issues.filter((i) => i.category !== "todo-fixme");
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
    return {
      ruleId: ruleIdOf(issue),
      ruleIndex: index.get(ruleIdOf(issue))!,
      level: levelOf(issue),
      message: { text: issue.cwe ? `${issue.message} (${issue.cwe})` : issue.message },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: encodeURI(issue.filePath.replace(/\\/g, "/")), uriBaseId: "%SRCROOT%" },
          region: { startLine: Math.max(1, issue.line) },
        },
      }],
      partialFingerprints: { "clarifydocFinding/v1": `${base}:${n}` },
      properties: { severity: issue.severity },
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "ClarifyDoc", informationUri: "https://github.com/clarifydoc/cli", version: toolVersion, rules: ordered } },
      results,
    }],
  };
}

const ruleIdOf = (issue: SecurityIssue): string => `clarifydoc/${issue.category}`;

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
};

type SarifLevel = "error" | "warning" | "note";
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
}
/** The SARIF 2.1.0 log `buildSarif` writes (the subset it fills). */
export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<{ tool: { driver: { name: string; informationUri: string; version: string; rules: SarifRule[] } }; results: SarifResult[] }>;
}
