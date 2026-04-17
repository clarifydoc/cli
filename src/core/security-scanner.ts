import type { SecurityIssue, SecurityCategory, SecuritySeverity, Language } from "../types/analysis.js";
import { stripPythonNonCode } from "../extractors/shared/python-tokenizer.js";

interface Rule {
  category: SecurityCategory;
  severity: SecuritySeverity;
  pattern: RegExp;
  message: string;
  languages?: string[];  // restrict to specific languages, or all if omitted
  excludeTest?: boolean;
}

const RULES: Rule[] = [
  // Hardcoded secrets
  {
    category: "hardcoded-secret",
    severity: "high",
    pattern: /(?:password|passwd|pwd|secret|api_key|apikey|token|auth_token|private_key)\s*[=:]\s*['"][^'"]{4,}['"]/i,
    message: "Hardcoded secret detected. Use environment variables or a secrets manager.",
    excludeTest: true,
  },
  // SQL injection
  {
    category: "sql-injection",
    severity: "high",
    pattern: /(?:query|execute)\s*\(\s*['"`][^'"`]*\s*\+/,
    message: "Possible SQL injection via string concatenation. Use parameterized queries.",
  },
  {
    category: "sql-injection",
    severity: "high",
    pattern: /\$\{[^}]*\}[^`]*(?:SELECT|INSERT|UPDATE|DELETE)/i,
    message: "Possible SQL injection via template literal. Use parameterized queries.",
  },
  // XSS
  {
    category: "xss",
    severity: "high",
    pattern: /innerHTML\s*=/,
    message: "Direct innerHTML assignment can lead to XSS. Sanitize user input.",
    languages: ["typescript", "javascript"],
  },
  {
    category: "xss",
    severity: "high",
    pattern: /dangerouslySetInnerHTML/,
    message: "dangerouslySetInnerHTML can lead to XSS attacks. Sanitize input.",
    languages: ["typescript", "javascript"],
  },
  // eval/exec
  {
    category: "eval-exec",
    severity: "medium",
    pattern: /\beval\s*\(/,
    message: "eval() executes arbitrary code. Avoid or validate input strictly.",
  },
  {
    category: "eval-exec",
    severity: "medium",
    pattern: /new\s+Function\s*\(/,
    message: "Function constructor is similar to eval(). Consider alternatives.",
    languages: ["typescript", "javascript"],
  },
  // Command injection
  {
    category: "command-injection",
    severity: "medium",
    pattern: /child_process/,
    message: "Shell command execution detected. Ensure input is sanitized.",
    languages: ["typescript", "javascript"],
  },
  {
    category: "command-injection",
    severity: "high",
    pattern: /\bos\.system\s*\(/,
    message: "os.system() is vulnerable to command injection. Use subprocess with shell=False.",
    languages: ["python"],
  },
  // Python-specific
  {
    category: "pickle",
    severity: "high",
    pattern: /pickle\.load/,
    message: "pickle.load() can execute arbitrary code. Use JSON or safe alternatives.",
    languages: ["python"],
  },
  {
    category: "subprocess-shell",
    severity: "high",
    pattern: /subprocess\.\w+\([^)]*shell\s*=\s*True/,
    message: "subprocess with shell=True is vulnerable to command injection.",
    languages: ["python"],
  },
  {
    category: "bare-except",
    severity: "medium",
    pattern: /\bexcept\s*:/,
    message: "Bare except catches all exceptions including SystemExit. Specify exception type.",
    languages: ["python"],
  },
  {
    category: "eval-exec",
    severity: "high",
    pattern: /\bexec\s*\(/,
    message: "exec() executes arbitrary Python code. This is almost always a security risk.",
    languages: ["python"],
  },
  // Debug statements (only flag if excessive — handled separately)
  {
    category: "debug-statement",
    severity: "low",
    pattern: /\bdebugger\b/,
    message: "debugger statement found. Remove before production.",
    languages: ["typescript", "javascript"],
  },
];

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
  if (language === "dfm") return [];

  const issues: SecurityIssue[] = [];
  // For Python, strip strings and comments to avoid false positives
  const effectiveSource = language === "python" ? stripPythonNonCode(sourceText) : sourceText;
  const lines = effectiveSource.split("\n");
  const originalLines = sourceText.split("\n"); // for snippets
  const isTest = isTestFile(filePath);

  // Apply regex rules
  for (const rule of RULES) {
    if (rule.languages && !rule.languages.includes(language)) continue;
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

  // Check for excessive console.log (>3 instances)
  if (language === "typescript" || language === "javascript") {
    const consoleLogs = lines.filter((l) => /console\.(log|debug|info)\(/.test(l));
    if (consoleLogs.length > 3) {
      issues.push({
        category: "debug-statement",
        severity: "low",
        message: `${consoleLogs.length} console statements found. Remove before production.`,
        filePath,
        line: lines.findIndex((l) => /console\.(log|debug|info)\(/.test(l)) + 1,
        snippet: "",
      });
    }
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
