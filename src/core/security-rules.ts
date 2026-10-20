import type { SecurityCategory, SecurityIssue, SecuritySeverity } from "../types/analysis.js";

/**
 * Rule identity for ClarifyDoc's own security findings: every finding carries
 * `ruleId: clarifydoc/<category>` — the id SARIF has always written — and that
 * id is what a team names to turn a rule off, change its severity, or silence
 * it on one line.
 *
 *   .clarifydoc/config.json   { "security": { "rules": { "todo-fixme": "off", "debug-statement": "low" } } }
 *   in the source             x = eval(expr)  # clarifydoc-ignore eval-exec
 *
 * A suppression names rules only with words that ARE rules: a bare
 * `clarifydoc-ignore`, or one followed by prose, still silences every rule on
 * the line, as it always did.
 */

export const SECURITY_CATEGORIES: readonly SecurityCategory[] = [
  "hardcoded-secret", "sql-injection", "xss", "eval-exec", "command-injection", "debug-statement", "todo-fixme",
  "pickle", "subprocess-shell", "bare-except", "deserialization", "xxe", "weak-crypto", "insecure-config",
  "missing-auth", "path-traversal", "ssrf", "open-redirect", "safe-method-write", "webhook-unverified", "missing-rate-limit", "missing-csrf",
];
const KNOWN = new Set<string>(SECURITY_CATEGORIES);
const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);

export const ruleIdOf = (category: SecurityCategory): string => `clarifydoc/${category}`;

/** A rule as a team writes it: `sql-injection` or `clarifydoc/sql-injection`. */
export function ruleCategory(name: string): SecurityCategory | null {
  const bare = name.trim().replace(/^clarifydoc\//, "");
  return KNOWN.has(bare) ? (bare as SecurityCategory) : null;
}

/**
 * What a suppression marker on a line silences: `"all"`, the rules it names,
 * or nothing (no marker). `next` reads the `-next-line` form.
 */
export function suppressionOf(line: string, next = false): "all" | Set<SecurityCategory> | null {
  const marker = next ? /\bclarifydoc-ignore-next-line\b(.*)$/ : /\bclarifydoc-ignore(?!-next-line)\b(.*)$/;
  const m = marker.exec(line);
  if (!m) return !next && /\b(?:nosec|NOSONAR)\b/.test(line) ? "all" : null;
  const named = new Set<SecurityCategory>();
  for (const word of m[1]!.split(/[\s,:;]+/)) {
    const c = word ? ruleCategory(word.replace(/[^\w/-]+$/, "")) : null;
    if (c) named.add(c);
  }
  return named.size ? named : "all";
}

export function isSuppressed(category: SecurityCategory, line: string, previous: string): boolean {
  for (const s of [suppressionOf(line), suppressionOf(previous, true)]) {
    if (s === "all" || s?.has(category)) return true;
  }
  return false;
}

export type RuleSetting = "off" | SecuritySeverity;

/** The `security` section of the project config. */
export interface SecurityConfig {
  rules?: Partial<Record<SecurityCategory, RuleSetting>>;
}

/** Read the section loosely: what is wrong is dropped with a warning, never fatal. */
export function parseSecurityConfig(raw: unknown, where: string): { config: SecurityConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: {}, warnings: [`${where}: "security" must be an object; ignored`] };
  const rulesRaw = (raw as { rules?: unknown }).rules;
  if (rulesRaw === undefined) return { config: {}, warnings };
  if (!rulesRaw || typeof rulesRaw !== "object" || Array.isArray(rulesRaw)) return { config: {}, warnings: [`${where}: "security.rules" must be an object; ignored`] };
  const rules: Partial<Record<SecurityCategory, RuleSetting>> = {};
  for (const [name, value] of Object.entries(rulesRaw)) {
    const category = ruleCategory(name);
    if (!category) {
      warnings.push(`${where}: security.rules "${name}" is not a rule (${SECURITY_CATEGORIES.join(", ")}); ignored`);
      continue;
    }
    const setting = typeof value === "object" && value !== null ? (value as { severity?: unknown }).severity : value;
    if (setting === "off" || (typeof setting === "string" && SEVERITIES.has(setting))) rules[category] = setting as RuleSetting;
    else warnings.push(`${where}: security.rules "${name}" must be "off" or a severity (critical, high, medium, low); ignored`);
  }
  return { config: { rules }, warnings };
}

/**
 * The project's findings with its rule settings applied: a rule turned off
 * drops its findings, a severity replaces the rule's own. New objects — the
 * per-file results are cached by content, and a config change must not
 * reach into them. Another tool's findings are its own rules' and pass as they are.
 */
export function applySecurityRules(issues: readonly SecurityIssue[], config: SecurityConfig | undefined): { issues: SecurityIssue[]; dropped: number } {
  const rules = config?.rules ?? {};
  let dropped = 0;
  const out: SecurityIssue[] = [];
  for (const issue of issues) {
    const setting = issue.tool ? undefined : rules[issue.category as SecurityCategory];
    if (setting === "off") {
      dropped++;
      continue;
    }
    if (issue.tool) out.push(issue);
    else out.push({ ...issue, ruleId: ruleIdOf(issue.category as SecurityCategory), ...(setting ? { severity: setting } : {}) });
  }
  return { issues: out, dropped };
}
