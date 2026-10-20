import { createHash } from "crypto";
import type { ApiRouteLinkStats, ContractFinding, DeadCodeReport, LayerViolation, PatternInfo, SecurityCategory, SecurityIssue } from "../types/analysis.js";
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
export function structuralFindings(summary: {
  apiRouteLinkStats?: ApiRouteLinkStats;
  layerViolations?: readonly LayerViolation[];
  contractFindings?: readonly ContractFinding[];
  deadCode?: DeadCodeReport;
  patterns?: readonly PatternInfo[];
}): StructuralFinding[] {
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
  // A query per loop pass or a blocking call: a warning where every request or message pays for it, else a note.
  for (const p of summary.patterns ?? []) {
    if (p.kind !== "query-in-loop" && p.kind !== "blocking-in-async") continue;
    const reach = p.entries?.length ? ` Reached from ${p.entries.map((e) => (e.kind === "route" ? e.entry : `${e.kind} ${e.entry}`)).join(", ")}.` : "";
    out.push({
      ruleId: `clarifydoc/${p.kind}`,
      title: p.kind === "query-in-loop" ? "Database query once per loop pass" : "Blocking call inside async code",
      level: p.role === "request" || p.role === "background" ? "warning" : "note",
      message: `${p.name}: ${p.detail}.${reach}`,
      file: p.filePath,
      line: p.line,
      fingerprint: `${p.name} ${p.detail.replace(/\bline \d+/g, "line")}`,
      tags: ["performance"],
    });
  }
  // Dead code is advice, never an error: files nothing reaches (only those no reachable file names), exports nothing imports.
  for (const f of summary.deadCode?.files ?? []) {
    if (f.confidence !== "INFERRED") continue;
    out.push({
      ruleId: "clarifydoc/unreachable-file",
      title: "File no entry point reaches",
      level: "note",
      message: `${f.filePath} is reached by no entry point${f.deadImporters ? ` (imported only by ${f.deadImporters} other unreachable file${f.deadImporters === 1 ? "" : "s"})` : ""}.`,
      file: f.filePath,
      line: 1,
      fingerprint: f.filePath,
      tags: ["dead-code"],
    });
  }
  for (const e of summary.deadCode?.exports ?? []) {
    out.push({
      ruleId: "clarifydoc/unused-export",
      title: "Export nothing imports",
      level: "note",
      message: e.usedInFile
        ? `${e.name} is exported but imported nowhere; it is used in its own file, so drop the export.`
        : `${e.name} is exported but used nowhere.`,
      file: e.filePath,
      line: e.line,
      fingerprint: `${e.kind} ${e.name}`,
      tags: ["dead-code"],
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
  return failingResults(log, { level }).length;
}

/**
 * What `--fail-on` gates on: a level (`error`, `warning`, `note`), finding
 * categories, or both, comma-separated — `--fail-on contract,route-miss`,
 * `--fail-on security,error`. A category is a rule tag (`security`,
 * `api-contract`, `architecture`, `performance`, `dead-code`), a rule id with
 * or without its `clarifydoc/` prefix (`sql-injection`, `import-rule`), or the
 * family a rule id starts with (`contract` → `contract-missing-field`, …;
 * `route-miss` is the `route-*` family). Categories alone gate at any level.
 */
export interface FailOn {
  level?: SarifLevel;
  categories?: readonly string[];
}

export function parseFailOn(value: string): FailOn {
  const tokens = value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) throw new Error("--fail-on needs a level (error, warning, note) or a finding category");
  const levels = tokens.filter((t): t is SarifLevel => t === "error" || t === "warning" || t === "note");
  if (levels.length > 1) throw new Error(`--fail-on takes one level, not ${levels.join(" and ")}`);
  const categories = tokens.filter((t) => !levels.includes(t as SarifLevel)).map((t) => t.replace(/^clarifydoc\//, ""));
  return { ...(levels[0] ? { level: levels[0] } : {}), ...(categories.length ? { categories } : {}) };
}

/** Categories `--fail-on` knows; anything else is refused, so a typo never gates on nothing. */
export const FAIL_ON_CATEGORIES = [
  "security", "api-contract", "architecture", "performance", "dead-code",
  "contract", "route-miss", "import-rule", "layer-order",
] as const;

/** Every rule id `structuralFindings` can produce, whether or not this run has one. */
export const STRUCTURAL_RULE_IDS: readonly string[] = [
  ...Object.keys(CONTRACT_TITLES).map((k) => `clarifydoc/contract-${k}`),
  ...Object.keys(ROUTE_MISS_TITLES).map((k) => `clarifydoc/route-${k}`),
  "clarifydoc/import-rule", "clarifydoc/layer-order", "clarifydoc/query-in-loop", "clarifydoc/blocking-in-async",
  "clarifydoc/unreachable-file", "clarifydoc/unused-export",
];

/** Is a category one `--fail-on` can match — a known family or tag, or a rule id this log or the security rules hold? */
export function isKnownCategory(category: string, ruleIds: Iterable<string>): boolean {
  if ((FAIL_ON_CATEGORIES as readonly string[]).includes(category)) return true;
  for (const id of ruleIds) if (id.replace(/^clarifydoc\//, "") === category) return true;
  return false;
}

/** The results a `--fail-on` gate counts (and, with a baseline, only the new ones). */
export function failingResults(log: SarifLog, gate: FailOn): SarifResult[] {
  const out: SarifResult[] = [];
  for (const run of log.runs) {
    for (const r of run.results) {
      if (r.baselineState === "unchanged") continue;
      if (gate.level && rank(r.level) < rank(gate.level)) continue;
      if (gate.categories && !gate.categories.some((c) => matchesCategory(r, run.tool.driver.rules[r.ruleIndex], c))) continue;
      out.push(r);
    }
  }
  return out;
}

function matchesCategory(r: SarifResult, rule: SarifRule | undefined, category: string): boolean {
  const id = r.ruleId.replace(/^clarifydoc\//, "");
  const family = category === "route-miss" ? "route" : category;
  return id === category || id.startsWith(`${family}-`) || (rule?.properties.tags.includes(category) ?? false);
}

/**
 * Marks each result `new` or `unchanged` against a SARIF log from the base
 * (SARIF's own `baselineState`), by the fingerprint `buildSarif` writes —
 * which survives a finding's line moving. A gate then counts only what the
 * change introduced. Returns how many results are new.
 */
export function applyBaseline(log: SarifLog, baseline: SarifLog): number {
  const known = new Set<string>();
  for (const run of baseline.runs ?? []) {
    for (const r of run.results ?? []) {
      const fp = r.partialFingerprints?.[FINGERPRINT_KEY];
      if (fp) known.add(`${r.ruleId}\u0000${fp}`);
    }
  }
  let fresh = 0;
  for (const run of log.runs) {
    for (const r of run.results) {
      const fp = r.partialFingerprints[FINGERPRINT_KEY];
      r.baselineState = fp && known.has(`${r.ruleId}\u0000${fp}`) ? "unchanged" : "new";
      if (r.baselineState === "new") fresh++;
    }
  }
  return fresh;
}

const FINGERPRINT_KEY = "clarifydocFinding/v1";

/**
 * The same results as a JUnit XML report — what CI systems without a SARIF
 * viewer show (GitLab's test report, Jenkins, Azure Pipelines): one test case
 * per rule, failing with each result the gate counts; the rest pass. With a
 * baseline, unchanged results do not fail.
 */
export function sarifToJunit(log: SarifLog, gate: FailOn = {}): string {
  const failing = new Set(failingResults(log, gate));
  const cases: string[] = [];
  let failures = 0;
  for (const run of log.runs) {
    for (const [i, rule] of run.tool.driver.rules.entries()) {
      const results = run.results.filter((r) => r.ruleIndex === i && failing.has(r));
      failures += results.length ? 1 : 0;
      const body = results.map((r) => {
        const loc = r.locations[0]?.physicalLocation;
        const where = loc ? `${decodeURI(loc.artifactLocation.uri)}:${loc.region.startLine}` : "";
        return `${where} ${r.message.text}`;
      }).join("\n");
      cases.push(
        `    <testcase classname="${xml(rule.properties.tags[0] ?? "clarifydoc")}" name="${xml(rule.id)}: ${xml(rule.shortDescription.text)}">` +
        (results.length ? `\n      <failure message="${xml(`${results.length} finding${results.length === 1 ? "" : "s"}`)}" type="${xml(rule.defaultConfiguration.level)}">${xml(body)}</failure>\n    ` : "") +
        `</testcase>`,
      );
    }
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="ClarifyDoc">`,
    `  <testsuite name="ClarifyDoc" tests="${cases.length}" failures="${failures}" errors="0">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
}

/**
 * The results as a GitLab Code Quality report (the Code Climate JSON subset
 * GitLab reads into a merge request's widget). Severity follows the level:
 * error → major, warning → minor, note → info; the fingerprint is ours, so
 * GitLab tells new findings from old ones by itself.
 */
export function sarifToCodeQuality(log: SarifLog): string {
  const sev: Record<SarifLevel, string> = { error: "major", warning: "minor", note: "info" };
  const out: unknown[] = [];
  for (const run of log.runs) {
    for (const r of run.results) {
      const loc = r.locations[0]?.physicalLocation;
      out.push({
        type: "issue",
        check_name: r.ruleId,
        description: r.message.text,
        categories: [run.tool.driver.rules[r.ruleIndex]?.properties.tags.includes("security") ? "Security" : "Bug Risk"],
        fingerprint: createHash("sha256").update(`${r.ruleId}\u0000${r.partialFingerprints[FINGERPRINT_KEY] ?? r.message.text}`).digest("hex").slice(0, 32),
        severity: sev[r.level],
        location: { path: loc ? decodeURI(loc.artifactLocation.uri) : "", lines: { begin: loc?.region.startLine ?? 1 } },
      });
    }
  }
  return JSON.stringify(out, null, 2) + "\n";
}

const xml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

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
  "missing-rate-limit": "Write route without the rate limit its siblings have",
  "missing-csrf": "Write route without the CSRF check its siblings have",
  "webhook-unverified": "Unverified webhook",
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
  /** Against a baseline log (`applyBaseline`): whether the base had this finding too. */
  baselineState?: "new" | "unchanged";
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
