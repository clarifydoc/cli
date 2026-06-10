import type { SecurityIssue, Language } from "../types/analysis.js";
import type { SecurityRule } from "../types/language-plugin.js";
import { pluginFor, securityRulesFor } from "../extractors/registry.js";

/**
 * Generic rules that apply to every language. Language-specific rules live
 * in each plugin's meta (`securityRules`); rule `priority` interleaves the
 * two sets deterministically (lower runs first), which also fixes the order
 * issues are reported in.
 */
const GENERIC_RULES: SecurityRule[] = [
  // Hardcoded secrets
  {
    category: "hardcoded-secret",
    severity: "high",
    pattern: /(?:password|passwd|pwd|secret|api_key|apikey|token|auth_token|private_key)\s*[=:]\s*['"][^'"]{4,}['"]/i,
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
  },
  {
    category: "sql-injection",
    severity: "high",
    pattern: /\$\{[^}]*\}[^`]*(?:SELECT|INSERT|UPDATE|DELETE)/i,
    message: "Possible SQL injection via template literal. Use parameterized queries.",
    priority: 12,
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

/** Check if a file path looks like a test file */
function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[^.]+$/.test(filePath)
    || filePath.includes("__tests__")
    || filePath.includes("/test/")
    || filePath.includes("/tests/")
    || filePath.includes("_test.")
    || filePath.includes("test_");
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

  const issues: SecurityIssue[] = [];
  // Plugin pre-filter (e.g. Python strips strings/comments to avoid false positives)
  const effectiveSource = plugin?.securityPreprocess
    ? plugin.securityPreprocess(sourceText)
    : sourceText;
  const lines = effectiveSource.split("\n");
  const originalLines = sourceText.split("\n"); // for snippets
  const isTest = isTestFile(filePath);

  // Apply regex rules
  for (const rule of rulesFor(language)) {
    if (rule.excludeTest && isTest) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (rule.pattern.test(line)) {
        // Skip if line is a comment
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        // Skip env variable references
        if (rule.category === "hardcoded-secret" && (
          line.includes("process.env") || line.includes("os.environ") ||
          line.includes("config.") || line.includes("settings.")
        )) {
          continue;
        }
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
  for (let i = 0; i < lines.length; i++) {
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(lines[i])) {
      todoMatches.push(i);
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
