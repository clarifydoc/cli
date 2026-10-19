import { describe, expect, it } from "vitest";
import { applySecurityRules, isSuppressed, parseSecurityConfig, suppressionOf } from "./security-rules.js";
import type { SecurityIssue } from "../types/analysis.js";

describe("suppressions", () => {
  it("names rules only with words that are rules", () => {
    expect(suppressionOf("x = eval(e)  # clarifydoc-ignore eval-exec")).toEqual(new Set(["eval-exec"]));
    expect(suppressionOf("q = raw(sql) // clarifydoc-ignore: sql-injection, clarifydoc/xss")).toEqual(new Set(["sql-injection", "xss"]));
    expect(suppressionOf("x = eval(e)  # clarifydoc-ignore")).toBe("all");
    // Prose after the marker is not a rule list: the old meaning holds.
    expect(suppressionOf("x = eval(e)  # clarifydoc-ignore this is a trusted constant")).toBe("all");
    expect(suppressionOf("x = 1 # nosec")).toBe("all");
    expect(suppressionOf("x = 1")).toBeNull();
  });

  it("silences only the named rule, on the line or from the line before", () => {
    expect(isSuppressed("eval-exec", "eval(x) # clarifydoc-ignore eval-exec", "")).toBe(true);
    expect(isSuppressed("sql-injection", "eval(x) # clarifydoc-ignore eval-exec", "")).toBe(false);
    expect(isSuppressed("sql-injection", "db.raw(q)", "  // clarifydoc-ignore-next-line sql-injection")).toBe(true);
    expect(isSuppressed("xss", "db.raw(q)", "  // clarifydoc-ignore-next-line sql-injection")).toBe(false);
    expect(isSuppressed("xss", "el.innerHTML = v", "// clarifydoc-ignore-next-line")).toBe(true);
    // The next-line form is not read as a same-line marker.
    expect(isSuppressed("xss", "el.innerHTML = v // clarifydoc-ignore-next-line", "")).toBe(false);
  });
});

describe("rule settings", () => {
  const issue = (category: SecurityIssue["category"], extra: Partial<SecurityIssue> = {}): SecurityIssue => ({ category, severity: "medium", message: "", filePath: "a.ts", line: 1, snippet: "", ...extra });

  it("reads off and severities, warning about the rest", () => {
    const { config, warnings } = parseSecurityConfig({ rules: { "todo-fixme": "off", "clarifydoc/debug-statement": "low", "weak-crypto": { severity: "high" }, nope: "off", xss: "loud" } }, "config");
    expect(config.rules).toEqual({ "todo-fixme": "off", "debug-statement": "low", "weak-crypto": "high" });
    expect(warnings).toHaveLength(2);
  });

  it("drops what is off and re-grades what is set, on copies, leaving other tools' findings alone", () => {
    const original = issue("debug-statement");
    const imported = issue("todo-fixme", { tool: "semgrep" });
    const { issues, dropped } = applySecurityRules([issue("todo-fixme"), original, imported], { rules: { "todo-fixme": "off", "debug-statement": "low" } });
    expect(dropped).toBe(1);
    expect(issues.map((i) => `${i.category}:${i.severity}`)).toEqual(["debug-statement:low", "todo-fixme:medium"]);
    expect(original.severity).toBe("medium");
  });
});
