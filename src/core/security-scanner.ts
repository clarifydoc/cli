import { isSuppressed } from "./security-rules.js";
import type { SecurityIssue, Language } from "../types/analysis.js";
import { splitLines } from "../extractors/shared/source-lines.js";
import type { SecurityRule } from "../types/language-plugin.js";
import { pluginFor, securityRulesFor } from "../extractors/registry.js";
import { isTestFile } from "./test-file-detector.js";

/**
 * Generic rules that apply to every language. Language-specific rules live
 * in each plugin's meta (`securityRules`); rule `priority` interleaves the
 * two sets deterministically (lower runs first), which also fixes the order
 * issues are reported in.
 */
/** Credential formats with a fixed shape (names for the message). */
export const SECRET_FORMATS: ReadonlyArray<readonly [string, RegExp]> = [
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{20,}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ["database password in a connection URL", /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s:@/'"`]+:[^\s@/'"`]{3,}@/],
];

/** An assignment of a credential-named value: `password = "…"`, `apiKey: '…'`. */
const SECRET_ASSIGNMENT = /\b((?:password|passwd|pwd|secret|api[_-]?key|apikey|token|auth[_-]?token|private[_-]?key|client[_-]?secret)\w*\s*[=:]\s*)(['"`])([^'"`\n]{4,})\2/gi;

/**
 * Text with every credential it carries masked: the fixed-shape formats the
 * scanner knows (cloud keys, tokens, private key blocks, a password in a
 * connection URL) and the value of a credential-named assignment that is not
 * a placeholder. For text that leaves the machine; line structure is kept.
 */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [, re] of SECRET_FORMATS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(g, (m) => (/BEGIN .*PRIVATE KEY/.test(m) ? m.replace(/PRIVATE KEY.*$/, "PRIVATE KEY«redacted»") : m.replace(/(:\/\/[^:@\s]+:)[^@\s]+@/, "$1«redacted»@").replace(/^(?!.*«redacted»).+$/, "«redacted»")));
  }
  return out.replace(SECRET_ASSIGNMENT, (m, lhs: string, q: string, value: string) => (isPlaceholderSecret(`${lhs}${q}${value}${q}`) ? m : `${lhs}${q}«redacted»${q}`));
}

/**
 * The password of the first `scheme://user:password@` in `value`: the user runs
 * to the first `:`, the password from there to the `@`, neither crossing
 * whitespace. Index scans, so a long run of `://` costs nothing.
 */
function urlPassword(value: string): string | undefined {
  for (let s = value.indexOf("://"); s >= 0; ) {
    let e = s + 3;
    while (e < value.length && value[e] !== "@" && !/\s/.test(value[e]!)) e++;
    if (value[e] === "@") {
      const userinfo = value.slice(s + 3, e);
      const colon = userinfo.indexOf(":");
      if (colon > 0 && colon < userinfo.length - 1) return userinfo.slice(colon + 1);
      s = value.indexOf("://", s + 1);
    } else {
      // Every `://` before the stop ends at the same whitespace or end.
      s = value.indexOf("://", e);
    }
  }
  return undefined;
}

/** A `<x>` hole: some `<` with a `>` after it. */
function angleHole(s: string): boolean {
  const open = s.indexOf("<");
  return open >= 0 && s.indexOf(">", open + 1) >= 0;
}

/**
 * A matched secret that is a placeholder, not a credential: documentation
 * values (`AKIAIOSFODNN7EXAMPLE`, `your-api-key-here`), template holes
 * (`${PASSWORD}`, `{{token}}`, `<password>`), masks (`****`, `xxxx`) and the
 * words people type when they mean "fill this in" (`changeme`, `dummy`).
 */
export function isPlaceholderSecret(text: string): boolean {
  // The value: the quoted literal of a `name = "value"` match, else all of it.
  const quoted = /['"`]([^'"`]*)['"`]\s*$/.exec(text);
  const value = (quoted ? quoted[1]! : text).trim();
  // A connection URL's password is the part between `:` and `@`.
  const secret = urlPassword(value) ?? value;
  // Template holes in any dialect: `${x}`, `{{x}}`, Ruby `#{x}`, ERB/JSP `<%= x %>`, `<x>`, `%(x)s`.
  // A shell substitution (`$(gh auth token)`) reads the secret at run time.
  if (/\$\{|\$\(|\{\{|#\{|<%|%\(|%s\b/.test(secret) || angleHole(secret)) return true;
  if (/^(?:\*+|x+|\.+|-+|_+|0+|1234\d*)$/i.test(secret)) return true;
  // A counting run no generator produces: a test value typed by hand
  // (`AKIA1234567890…`, `ghp_1234567890abcdefghij…`).
  if (/0123456789|1234567890|abcdefghij|ABCDEFGHIJ/.test(secret)) return true;
  return /example|placeholder|changeme|change[-_]me|your[-_ ]|dummy|sample|redacted|replace[-_]?me|^pass(?:word)?$|^secret$|^(?:test|fake|todo|none|null|undefined)$|here$/i.test(secret);
}

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
  // Credentials recognisable by their FORMAT, whatever the variable is called:
  // `new Stripe("sk_live_…")`, `AWS_ACCESS_KEY_ID = "AKIA…"`, a pasted PEM key,
  // a connection URL carrying its password. Matched on the raw text (a
  // language pre-filter may blank strings) and in comments too: a key in a
  // comment has leaked just the same.
  ...SECRET_FORMATS.map(([name, pattern], k): SecurityRule => ({
    category: "hardcoded-secret",
    severity: "high",
    pattern,
    message: `Hardcoded ${name}. Revoke it, and load it from the environment or a secrets manager.`,
    priority: 10.1 + k / 100,
    excludeTest: true,
    raw: true,
  })),
  // SQL injection: a statement literal concatenated with a value, as the first
  // argument of a query call (`db.query("SELECT … id=" + id)`,
  // `stmt.executeQuery("…" + id)`, `new SqlCommand("…" + id, conn)`). The
  // literal must read as SQL; a placeholder query passes values separately.
  {
    category: "sql-injection",
    severity: "high",
    multiline: true,
    pattern: /\b(?:query|execute|executeQuery|executeUpdate|createQuery|createNativeQuery|prepareStatement|rawQuery|SqlCommand|FromSqlRaw|ExecuteSqlRaw)\s*\(\s*(["'`])(?=(?:\\.|(?!\1)[^\\])*?\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM|INTO|VALUES|SET)\b)(?:\\.|(?!\1)[^\\])*\1\s*\+/i,
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
/**
 * Whether a source text looks minified or bundled (see the signals above).
 * Small texts are never flagged.
 *
 * @param sourceText - The whole file
 */
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

/**
 * Whether the file opens with a third-party license header (first 4 KiB only).
 * See the note above: honoured at aggregation, never as a per-file skip.
 *
 * @param sourceText - The whole file
 */
/** A library build's banner: `/*! jQuery v1.11.1 | (c) … */`, `/*! jQuery UI - v1.11.1 - 2014-08-13`. */
const LIBRARY_BANNER_RE = /^\s*\/\*!\s*[A-Za-z][\w.\- ]*?\s(?:-\s*)?v\d+\.\d+/;

export function isVendoredSource(sourceText: string): boolean {
  return LIBRARY_BANNER_RE.test(sourceText.slice(0, 200)) || THIRD_PARTY_LICENSE_RE.test(sourceText.slice(0, 4096));
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

/**
 * The line a finding quotes, trimmed and capped. A hardcoded-secret line has
 * its string values masked: the snippet travels into project-summary.json,
 * report.html and MCP answers, and the report must not be how a credential
 * leaves the repository. A long value keeps its first 4 characters (enough to
 * tell an `AKIA…` key from a `ghp_…` token), a short one keeps none.
 */
function snippetOf(line: string, category: SecurityIssue["category"]): string {
  let text = line.trim();
  if (category === "hardcoded-secret") {
    const mask = (value: string): string =>
      `${value.length >= 12 ? value.slice(0, 4) : ""}${"*".repeat(Math.min(8, Math.max(4, value.length - 4)))}`;
    // A connection URL's password, then any credential by its format (quoted
    // or not), then every remaining string literal on the line.
    text = text.replace(/(:\/\/[^\s:@/'"`]+:)([^\s@/'"`]+)@/g, (_m, head: string, pass: string) => `${head}${mask(pass)}@`);
    for (const [, re] of SECRET_FORMATS) {
      if (re.source.startsWith("-----")) continue;
      text = text.replace(new RegExp(re.source, "g"), (m) => mask(m));
    }
    text = text.replace(/(['"`])((?:\\.|(?!\1)[^\\])+)\1/g, (_m, q: string, value: string) =>
      value.includes("****") ? `${q}${value}${q}` : `${q}${mask(value)}${q}`);
  }
  return text.substring(0, 100);
}

/**
 * The CWE each category is an instance of by default. `insecure-config`
 * rules name their own (TLS off, CSRF off, CORS, debug mode differ); `todo-fixme`
 * is no weakness.
 */
export const CATEGORY_CWE: Partial<Record<SecurityIssue["category"], string>> = {
  "hardcoded-secret": "CWE-798",
  "sql-injection": "CWE-89",
  xss: "CWE-79",
  "eval-exec": "CWE-95",
  "command-injection": "CWE-78",
  "subprocess-shell": "CWE-78",
  "debug-statement": "CWE-489",
  pickle: "CWE-502",
  deserialization: "CWE-502",
  xxe: "CWE-611",
  "weak-crypto": "CWE-327",
  "bare-except": "CWE-396",
  "insecure-config": "CWE-16",
  "missing-auth": "CWE-306",
  "path-traversal": "CWE-22",
  ssrf: "CWE-918",
  "open-redirect": "CWE-601",
  "safe-method-write": "CWE-650",
  "webhook-unverified": "CWE-345",
  "missing-rate-limit": "CWE-770",
  "missing-csrf": "CWE-352",
};

/** A TODO/FIXME/HACK/XXX marker after a comment opener on its line, or on a block-comment continuation line. */
const TODO_IN_COMMENT_RE = /(?:\/\/|\/\*|(?:^|\s)#|<!--|(?:^|\s)--|^\s*\*|^\s*;|^\s*'|\(\*)[^\n]*?\b(?:TODO|FIXME|HACK|XXX)\b/;

/** Text before a match that opens a comment on the same line. */
const TRAILING_COMMENT_RE = /(?:^|\s)(?:\/\/|#(?=\s|$)|<!--)/;

/** Offset of each line's first character. */
function startsOfLines(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** The 0-based line holding `offset` (binary search over `startsOfLines`). */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Merged generic + plugin rules per language, sorted by priority (cached). */
const mergedRulesCache = new Map<Language, readonly SecurityRule[]>();

/** The generic security rules plus the language's own, sorted by priority and cached per language. */
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
  const lines = splitLines(effectiveSource);
  let originalLines: string[] | null = null; // for snippets, split on first hit
  const isTest = isTestFile(filePath, language);

  // A finding at line `i` (0-based) whose match `text` starts at column `col`,
  // unless the line says it is not one: a comment, a suppression, a secret
  // read from configuration rather than written into the code, a placeholder.
  const report = (rule: SecurityRule, i: number, col: number, text: string): void => {
    originalLines ??= splitLines(sourceText);
    const line = (rule.raw ? originalLines[i] : lines[i]) ?? "";
    // A credential is leaked wherever it is written, comments included; every
    // other rule is about code.
    if (!(rule.raw && rule.category === "hardcoded-secret")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("<!--")) {
        return;
      }
      // A trailing comment (`x = 1; // token="…"`, `<!-- … -->`): the match is not code.
      if (TRAILING_COMMENT_RE.test(line.slice(0, col))) return;
    }
    if (rule.category === "hardcoded-secret" && isPlaceholderSecret(text)) return;
    // Suppressed on the line (`nosec`, `NOSONAR`, `clarifydoc-ignore [rule…]`) or by
    // the line before (`clarifydoc-ignore-next-line [rule…]`), every rule or the
    // ones named. Read from the source as written: a plugin's pre-filter may
    // have blanked its comments.
    if (isSuppressed(rule.category, originalLines[i] ?? "", originalLines[i - 1] ?? "")) return;
    if (rule.category === "hardcoded-secret") {
      // Env reads and KEY_* constants — an identifier NAMED `KEY_PASSWORD`
      // holds a settings-store key name, not a secret
      // (`const val KEY_PASSWORD = "myDpPassword"`). A value read FROM
      // config after the match is no literal secret either; `config.dbPassword
      // = "…"` (config written to) still is.
      const after = line.slice(col);
      if (line.includes("process.env") || line.includes("os.environ") ||
        after.includes("config.") || after.includes("settings.") ||
        /(?:^|[^\w])KEY_\w*\s*[=:]/.test(line)) return;
    }
    let severity = rule.severity;
    let message = rule.message;
    if (rule.judge && !rule.raw) {
      lineStarts ??= startsOfLines(effectiveSource);
      const verdict = rule.judge(effectiveSource, lineStarts[i]! + col);
      if (verdict?.drop) return;
      if (verdict?.severity) severity = verdict.severity;
      if (verdict?.message) message = verdict.message;
    }
    const issue: SecurityIssue = {
      category: rule.category,
      severity,
      message,
      filePath,
      line: i + 1,
      snippet: snippetOf(originalLines[i] ?? line, rule.category),
    };
    if (rule.cwe) issue.cwe = rule.cwe;
    issues.push(issue);
  };

  // Apply regex rules
  let lineStarts: number[] | null = null;
  let rawLines: string[] | null = null;
  for (const rule of rulesFor(language)) {
    if (rule.excludeTest && isTest) continue;
    if (rule.files && !rule.files.test(filePath)) continue;
    const text = rule.raw ? sourceText : effectiveSource;
    // Whole-text gate: a per-line match implies a whole-text match, so a
    // rule that matches nothing in the file skips the per-line loop.
    if (!rule.pattern.test(text)) continue;

    if (rule.multiline) {
      // A statement formatted across lines (`db.query(\n  "SELECT …" +\n  id)`):
      // match the whole text, report at the line the match starts on.
      if (rule.raw) throw new Error("a security rule is raw or multiline, not both");
      lineStarts ??= startsOfLines(effectiveSource);
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
      for (let m = re.exec(effectiveSource); m; m = re.exec(effectiveSource)) {
        const i = lineIndexAt(lineStarts, m.index);
        report(rule, i, m.index - lineStarts[i]!, m[0]);
        if (m[0].length === 0) re.lastIndex++;
      }
      continue;
    }
    const scanned = rule.raw ? (rawLines ??= splitLines(sourceText)) : lines;
    for (let i = 0; i < scanned.length; i++) {
      const m = rule.pattern.exec(scanned[i]!);
      if (m) report(rule, i, m.index, m[0]);
    }
  }

  // Plugin whole-file checks (e.g. excessive console.log for JS/TS)
  if (plugin?.securityPostScan) {
    issues.push(...plugin.securityPostScan(lines, filePath));
  }

  // Check for TODO/FIXME/HACK — in comments: `"TODO"` in a string is data
  // (a status value, a column name), not a note to the author. The source as
  // written, since a plugin's preprocess may already have blanked comments.
  const todoMatches: number[] = [];
  if (/\b(TODO|FIXME|HACK|XXX)\b/.test(sourceText)) {
    originalLines ??= splitLines(sourceText);
    for (let i = 0; i < originalLines.length; i++) {
      if (TODO_IN_COMMENT_RE.test(originalLines[i]!)) {
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
      snippet: originalLines![todoMatches[0]]!.trim().substring(0, 100),
    });
  }

  // The weakness each finding is an instance of, where its rule named none.
  for (const issue of issues) {
    if (!issue.cwe && CATEGORY_CWE[issue.category]) issue.cwe = CATEGORY_CWE[issue.category];
  }
  return issues;
}
