import type { SecurityIssue, Language } from "../types/analysis.js";
import type { SecurityRule } from "../types/language-plugin.js";
import { pluginFor, securityRulesFor } from "../extractors/registry.js";
import { isTestFile } from "./test-file-detector.js";

/**
 * Generic rules that apply to every language. Language-specific rules live
 * in each plugin's meta (`securityRules`); rule `priority` interleaves the
 * two sets deterministically (lower runs first), which also fixes the order
 * issues are reported in.
 */
const GENERIC_RULES: SecurityRule[] = [
  // Hardcoded secrets. The value must not start with `/` (a URL path —
  // `resetPassword = '/passwordReset'` is a route constant, not a credential)
  // nor with whitespace/`.`/`+` — those mean the "value" opened at a CLOSING
  // quote inside string concatenation (`dd("by Token: ".$identifier."…")`,
  // `console.log("token: " + token…)`), i.e. a log line, not an assignment.
  {
    category: "hardcoded-secret",
    severity: "high",
    pattern: /(?:password|passwd|pwd|secret|api_key|apikey|token|auth_token|private_key)\s*[=:]\s*['"](?![\s./+])[^'"]{4,}['"]/i,
    message: "Hardcoded secret detected. Use environment variables or a secrets manager.",
    priority: 10,
    excludeTest: true,
  },
  // SQL injection
  {
    category: "sql-injection",
    severity: "high",
    pattern: /(?:query|execute)\s*\(\s*['"`][^'"`]*\s*\+/,
    message: "Possible SQL injection via string concatenation. Use parameterized queries.",
    priority: 11,
    excludeTest: true,
  },
  // A template literal is only SQL when it contains a real statement shape
  // (SELECT … FROM / INSERT INTO / UPDATE … SET / DELETE FROM) next to an
  // interpolation — a bare keyword substring matches ordinary prose and
  // identifiers (`totalSelected`, `effectsOfUpdate`).
  {
    category: "sql-injection",
    severity: "high",
    pattern: /\b(?:SELECT\s+[\w*,\s]+?\s*FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^`]*\$\{|\$\{[^}]*\}[^`]*\b(?:SELECT\s+[\w*,\s]+?\s*FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
    message: "Possible SQL injection via template literal. Use parameterized queries.",
    priority: 12,
    excludeTest: true,
  },
  // eval/exec
  {
    category: "eval-exec",
    severity: "medium",
    pattern: /\beval\s*\(/,
    message: "eval() executes arbitrary code. Avoid or validate input strictly.",
    priority: 30,
  },
];

/**
 * Minified or bundled build artifact — not authored source. Findings in these
 * files (vendored library internals, webpack output) aren't actionable, and
 * their repeated helper functions pollute duplicate detection. Signals: a
 * bundler runtime marker, a single enormous line, or a minified-typical
 * average line length.
 */
const BUNDLE_MARKER_RE = /__webpack_require__|webpackJsonp|webpackChunk|\bparcelRequire\b|System\.register\(/;
export function isMinifiedSource(sourceText: string): boolean {
  if (sourceText.length < 2000) return false;
  if (BUNDLE_MARKER_RE.test(sourceText)) return true;
  let lines = 1;
  let maxLine = 0;
  let start = 0;
  for (let i = 0; i <= sourceText.length; i++) {
    if (i === sourceText.length || sourceText.charCodeAt(i) === 10) {
      const len = i - start;
      if (len > maxLine) maxLine = len;
      if (i < sourceText.length) { lines++; start = i + 1; }
    }
  }
  return maxLine >= 5000 || sourceText.length / lines >= 200;
}

/**
 * Third-party license/attribution header — vendored source committed straight
 * into the repo (2000s-era JS widgets, jsTree, a Kruse CalendarPopup pasted
 * into a JSP). Head-window only; in-house code doesn't open with a
 * grant-of-rights. NOTE: some open-source projects stamp a license header on
 * EVERY authored file — that's why this flag is only honored at aggregation
 * when licensed files are a small minority of the repo (see analyzer.ts),
 * never as a per-file scan skip.
 */
const THIRD_PARTY_LICENSE_RE =
  /Permission is hereby granted|The MIT License|terms of the MIT License|opensource\.org\/licenses|You may use this code for any purpose|Released under the (?:MIT|BSD|Apache|GPL|LGPL|MPL)|Licensed under the (?:MIT|BSD|Apache|GPL|LGPL|MPL)/i;

export function isVendoredSource(sourceText: string): boolean {
  return THIRD_PARTY_LICENSE_RE.test(sourceText.slice(0, 4096));
}

/**
 * The license-headered files to treat as vendored — ONLY when they're a small
 * minority of the repo. An open-source project stamps a license header on
 * every authored file; treating those as vendored would silently disable its
 * scanning, so a repo-wide convention disables the flag instead.
 */
export function vendoredMinoritySet(
  analyses: ReadonlyArray<{ filePath: string; vendored?: boolean }>,
): Set<string> {
  const licensed = analyses.filter((a) => a.vendored).map((a) => a.filePath);
  return new Set(
    licensed.length > 0 && licensed.length / analyses.length < 0.25 ? licensed : [],
  );
}

/** Merged generic + plugin rules per language, sorted by priority (cached). */
const mergedRulesCache = new Map<Language, readonly SecurityRule[]>();

function rulesFor(language: Language): readonly SecurityRule[] {
  let rules = mergedRulesCache.get(language);
  if (!rules) {
    rules = [...GENERIC_RULES, ...securityRulesFor(language)].sort((a, b) => a.priority - b.priority);
    mergedRulesCache.set(language, rules);
  }
  return rules;
}

/**
 * Scan source text for security issues.
 */
export function scanSecurity(
  sourceText: string,
  filePath: string,
  language: Language,
): SecurityIssue[] {
  const plugin = pluginFor(language);
  if (plugin?.skipSecurityScan) return [];
  // Vendored/minified/bundled artifacts: nothing in them is actionable.
  if (isMinifiedSource(sourceText)) return [];

  const issues: SecurityIssue[] = [];
  // Plugin pre-filter (e.g. Python strips strings/comments to avoid false positives)
  const effectiveSource = plugin?.securityPreprocess
    ? plugin.securityPreprocess(sourceText)
    : sourceText;
  const lines = effectiveSource.split("\n");
  let originalLines: string[] | null = null; // for snippets, split on first hit
  const isTest = isTestFile(filePath, language);

  // Apply regex rules
  for (const rule of rulesFor(language)) {
    if (rule.excludeTest && isTest) continue;
    // Whole-text gate: a per-line match implies a whole-text match, so a
    // rule that matches nothing in the file skips the per-line loop.
    if (!rule.pattern.test(effectiveSource)) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (rule.pattern.test(line)) {
        // Skip if line is a comment
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        // Skip env variable references, and KEY_* constants — an identifier
        // NAMED `KEY_PASSWORD` holds a settings-store key name, not a secret
        // (`const val KEY_PASSWORD = "istDpPassword"`).
        if (rule.category === "hardcoded-secret" && (
          line.includes("process.env") || line.includes("os.environ") ||
          line.includes("config.") || line.includes("settings.") ||
          /(?:^|[^\w])KEY_\w*\s*[=:]/.test(line)
        )) {
          continue;
        }
        originalLines ??= sourceText.split("\n");
        issues.push({
          category: rule.category,
          severity: rule.severity,
          message: rule.message,
          filePath,
          line: i + 1,
          snippet: (originalLines[i] ?? line).trim().substring(0, 100),
        });
      }
    }
  }

  // Plugin whole-file checks (e.g. excessive console.log for JS/TS)
  if (plugin?.securityPostScan) {
    issues.push(...plugin.securityPostScan(lines, filePath));
  }

  // Check for TODO/FIXME/HACK
  const todoMatches: number[] = [];
  if (/\b(TODO|FIXME|HACK|XXX)\b/.test(effectiveSource)) {
    for (let i = 0; i < lines.length; i++) {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(lines[i])) {
        todoMatches.push(i);
      }
    }
  }
  if (todoMatches.length > 0) {
    issues.push({
      category: "todo-fixme",
      severity: "low",
      message: `${todoMatches.length} TODO/FIXME comments found.`,
      filePath,
      line: todoMatches[0] + 1,
      snippet: lines[todoMatches[0]].trim().substring(0, 100),
    });
  }

  return issues;
}
