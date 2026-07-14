import { describe, it, expect } from "vitest";
import { scanSecurity, isVendoredSource, vendoredMinoritySet } from "./security-scanner.js";

const cats = (src: string, filePath = "src/app.ts") =>
  scanSecurity(src, filePath, "typescript").map((i) => i.category);

// ─── SQL injection: template literals ───────────────────────────────────────
// The rule must require an actual SQL statement shape, not a bare keyword
// substring — `totalSelected` and `effectsOfUpdate` are not SQL (tessa FPs).

describe("scanSecurity — sql-injection template rule", () => {
  it("does not flag prose or identifiers containing SQL keyword substrings", () => {
    expect(cats("const t = `Der er konflikter på ${conflictCount} ud af de ${totalSelected.value} markerede`;"))
      .not.toContain("sql-injection");
    expect(cats("requestUri(`personfravaer/${absenceExternalId}/effectsOfUpdate`),"))
      .not.toContain("sql-injection");
    expect(cats("requestUri(`personfravaer/${absenceExternalId}/effectsOfDelete`)"))
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
// Static literals can't inject; comparisons don't assign (tessa FPs:
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

// ─── Hardcoded secrets: route paths and key-name constants (spsflow FPs) ────

describe("scanSecurity — hardcoded-secret rule", () => {
  it("does not flag debug prints that concatenate a token variable", () => {
    expect(cats('dd("Retrieve by Token: ".$identifier." and ". $token);', "app/ApiUserProvider.php"))
      .not.toContain("hardcoded-secret");
    expect(cats('console.log("Access token: " + token.substring(0, 10) + "...")'))
      .not.toContain("hardcoded-secret");
  });

  it("does not flag URL-path values or KEY_* constants", () => {
    expect(cats("static const String resetPassword = '/passwordReset';", "lib/RouterGenerator.dart"))
      .not.toContain("hardcoded-secret");
    expect(cats('const val KEY_PASSWORD = "istDpPassword"', "src/SystemVariablesService.kt"))
      .not.toContain("hardcoded-secret");
    expect(cats('const val KEY_CC_API_KEY = "commandoCentralApiKey"', "src/SystemVariablesService.kt"))
      .not.toContain("hardcoded-secret");
  });

  it("still flags real credentials", () => {
    expect(cats("const client_secret = 'fake-client-secret-0001';"))
      .toContain("hardcoded-secret");
    expect(cats('val token = "fake-token-0001"')).toContain("hardcoded-secret");
    // The KEY_ veto is about `KEY_*` NAMES — an API_KEY holding a value stays flagged.
    expect(cats("API_KEY = 'abc123def456'")).toContain("hardcoded-secret");
  });
});

// ─── Minified/bundled artifacts are skipped wholesale (spsflow FPs) ──────────

describe("scanSecurity — minified/bundle skip", () => {
  it("skips a file with an enormous minified line", () => {
    const minified = "var a=1;" + "el.innerHTML = userInput;".repeat(300);
    expect(scanSecurity(minified, "public/js/plugins/sweetalert2.all.js", "javascript")).toHaveLength(0);
  });

  it("skips a webpack bundle regardless of line shape", () => {
    const bundle =
      "/******/ (function(modules) {\n__webpack_require__(0);\n" +
      "el.innerHTML = userInput;\n".repeat(200);
    expect(scanSecurity(bundle, "public/js/app.js", "javascript")).toHaveLength(0);
  });

  it("still scans normal source of the same size", () => {
    const normal = "function f(x) {\n  el.innerHTML = userInput;\n}\n".repeat(100);
    expect(scanSecurity(normal, "src/app.ts", "typescript").map((i) => i.category)).toContain("xss");
  });
});

describe("vendored third-party source detection", () => {
  const kruse = `// ===================================================
// Author: Matt Kruse <matt@mattkruse.com>
// WWW: http://www.mattkruse.com/
// NOTICE: You may use this code for any purpose, commercial or
// private, without any further permission from the author.
// ===================================================
function PopupWindow_getXYPosition() { document.all[x].innerHTML = y; }`;

  const jstree = `/*!
 * jsTree 3.0.0
 * http://jstree.com/
 * Copyright (c) 2014 Ivan Bozhanov (http://vakata.com)
 * Licensed same as jquery - under the terms of the MIT License
 *   http://www.opensource.org/licenses/mit-license.php
 */
(function (factory) {})();`;

  it("recognizes grant-of-rights and MIT headers", () => {
    expect(isVendoredSource(kruse)).toBe(true);
    expect(isVendoredSource(jstree)).toBe(true);
  });

  it("does not flag plain corporate copyright headers", () => {
    expect(isVendoredSource(`/*\n * Copyright (c) 2019 IST - International Software Technology. All rights reserved.\n */\nclass X {}`)).toBe(false);
  });

  it("vendoredMinoritySet honors the flag only when licensed files are a minority", () => {
    const files = (n: number, vendoredCount: number) =>
      Array.from({ length: n }, (_, i) => ({ filePath: `f${i}.js`, vendored: i < vendoredCount }));
    // 3 of 100 → vendored
    expect(vendoredMinoritySet(files(100, 3)).size).toBe(3);
    // 80 of 100 → repo-wide license convention, flag disabled
    expect(vendoredMinoritySet(files(100, 80)).size).toBe(0);
    // none licensed → empty
    expect(vendoredMinoritySet(files(10, 0)).size).toBe(0);
  });
});
