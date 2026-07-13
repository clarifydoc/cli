import { describe, it, expect } from "vitest";
import { scanSecurity } from "./security-scanner.js";

const cats = (src: string, filePath = "src/app.ts") =>
  scanSecurity(src, filePath, "typescript").map((i) => i.category);

// ─── SQL injection: template literals ───────────────────────────────────────
// The rule must require an actual SQL statement shape, not a bare keyword
// substring — `totalSelected` and `effectsOfUpdate` are not SQL (real-repo FPs).

describe("scanSecurity — sql-injection template rule", () => {
  it("does not flag prose or identifiers containing SQL keyword substrings", () => {
    expect(cats("const t = `There are clashes on ${conflictCount} of the ${totalSelected.value} selected fixtures`;"))
      .not.toContain("sql-injection");
    expect(cats("requestUri(`playerinjury/${absenceExternalId}/effectsOfUpdate`),"))
      .not.toContain("sql-injection");
    expect(cats("requestUri(`playerinjury/${absenceExternalId}/effectsOfDelete`)"))
      .not.toContain("sql-injection");
  });

  it("flags interpolation inside a real SQL statement, in either order", () => {
    expect(cats("db.query(`SELECT * FROM users WHERE id = ${id}`);")).toContain("sql-injection");
    expect(cats("db.query(`UPDATE users SET name = ${name}`);")).toContain("sql-injection");
    expect(cats("db.query(`DELETE FROM t WHERE id = ${id}`);")).toContain("sql-injection");
    expect(cats("db.query(`INSERT INTO t (a) VALUES (${v})`);")).toContain("sql-injection");
    // interpolation before the statement
    expect(cats("const q = `${prefix} SELECT id FROM accounts`;")).toContain("sql-injection");
  });

  it("skips test files", () => {
    expect(cats("db.query(`SELECT * FROM users WHERE id = ${id}`);", "src/app.spec.ts"))
      .not.toContain("sql-injection");
  });
});

// ─── XSS: innerHTML assignments ─────────────────────────────────────────────
// Static literals can't inject; comparisons don't assign (real-repo FPs:
// `document.body.innerHTML = ''` in a spec, static fallback markup in main.ts).

describe("scanSecurity — xss innerHTML rule", () => {
  it("does not flag static-literal assignments or comparisons", () => {
    expect(cats("document.body.innerHTML = '';")).not.toContain("xss");
    expect(cats("el.innerHTML = '<div>static</div>';")).not.toContain("xss");
    expect(cats("el.innerHTML = '<a>one</a>' + '<b>two</b>';")).not.toContain("xss");
    expect(cats("if (el.innerHTML === '<p>x</p>') { reset(); }")).not.toContain("xss");
    // RHS on the next line is unknowable line-by-line — stay quiet
    expect(cats("rootElement.innerHTML =")).not.toContain("xss");
  });

  it("flags assignments with dynamic content", () => {
    expect(cats("el.innerHTML = userInput;")).toContain("xss");
    expect(cats("el.innerHTML = `<b>${name}</b>`;")).toContain("xss");
    expect(cats("el.innerHTML = '<b>' + name + '</b>';")).toContain("xss");
    expect(cats("el.innerHTML += chunk;")).toContain("xss");
    expect(cats("el.innerHTML = render(data);")).toContain("xss");
  });

  it("skips test files", () => {
    expect(cats("el.innerHTML = userInput;", "src/Foo.spec.ts")).not.toContain("xss");
  });
});
