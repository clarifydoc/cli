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

describe("scanSecurity — sql-injection concatenation rule", () => {
  const at = (src: string, file: string, lang: Parameters<typeof scanSecurity>[2]) =>
    scanSecurity(src, file, lang).filter((i) => i.category === "sql-injection").map((i) => i.line);

  it("flags a SQL literal concatenated with a value", () => {
    // The rule once required the `+` INSIDE the string, so none of these fired.
    expect(at('db.query("SELECT * FROM u WHERE id=" + id);', "src/a.ts", "typescript")).toEqual([1]);
    expect(at('rs = stmt.executeQuery("SELECT a FROM t WHERE x=" + n);', "src/A.java", "java")).toEqual([1]);
    expect(at('var c = new SqlCommand("DELETE FROM t WHERE id=" + id, conn);', "src/A.cs", "csharp")).toEqual([1]);
  });

  it("leaves placeholders, plain literals and non-SQL strings alone", () => {
    expect(at('db.query("SELECT * FROM u WHERE id = ?", [id]);', "src/a.ts", "typescript")).toEqual([]);
    expect(at('db.query("SELECT 1");', "src/a.ts", "typescript")).toEqual([]);
    expect(at('api.query("hello " + name);', "src/a.ts", "typescript")).toEqual([]);
  });

  it("reads Python's built statements through its blanked strings", () => {
    const src = [
      'cursor.execute("SELECT * FROM u WHERE id=" + uid)',
      'cursor.execute(f"SELECT * FROM u WHERE id={uid}")',
      'cursor.execute("SELECT * FROM u WHERE id=%s" % uid)',
      'cursor.execute("SELECT * FROM u WHERE id={}".format(uid))',
      'cursor.execute("SELECT * FROM u WHERE id=%s", (uid,))',
      "cursor.execute(query)",
    ].join("\n");
    expect(at(src, "app/db.py", "python")).toEqual([1, 2, 3, 4]);
  });
});

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

describe("scanSecurity — secret snippets", () => {
  it("never quotes the secret itself", () => {
    const [short] = scanSecurity('const dbPassword = "Pr0d-Hunter2!";', "src/db.ts", "typescript");
    expect(short!.snippet).not.toContain("Hunter2");
    expect(short!.snippet).toMatch(/^const dbPassword = "Pr0d\*+";$/);
    const [tiny] = scanSecurity("const token = 'abc123';", "src/db.ts", "typescript");
    expect(tiny!.snippet).toBe("const token = '****';");
  });
});

describe("scanSecurity — what a line says about itself", () => {
  const found = (src: string, file = "src/a.ts", lang: Parameters<typeof scanSecurity>[2] = "typescript") =>
    scanSecurity(src, file, lang).filter((i) => i.category !== "todo-fixme" && i.category !== "debug-statement").map((i) => [i.category, i.line]);

  it("matches a SQL statement formatted across lines, at the line it starts", () => {
    expect(found(["const r = await db.query(", '  "SELECT * FROM users WHERE id = " +', "  id,", ");"].join("\n"))).toEqual([["sql-injection", 1]]);
    expect(found(["cursor.execute(", '    "SELECT * FROM t WHERE id = %s"', "    % uid", ")"].join("\n"), "app/db.py", "python")).toEqual([["sql-injection", 1]]);
  });

  it("reports a secret written into config, not one read from it", () => {
    expect(found('config.dbPassword = "S3cret-value!";')).toEqual([["hardcoded-secret", 1]]);
    expect(found('const password = "fallback-x" || settings.password;')).toEqual([]);
  });

  it("skips matches inside a trailing comment", () => {
    expect(found('const a = 1; // password = "hunter2-old"')).toEqual([]);
    expect(found('<div></div> <!-- token: "abcd-efgh" -->', "src/a.html", "html")).toEqual([]);
  });

  it("honours inline suppressions", () => {
    expect(found('const password = "fixture-only"; // nosec')).toEqual([]);
    expect(found('const token = "known-public-token"; // NOSONAR')).toEqual([]);
    expect(found(['// clarifydoc-ignore-next-line', 'const secret = "documented-example";'].join("\n"))).toEqual([]);
    // Python blanks comments before matching; the suppression is still read.
    expect(found('cursor.execute(f"SELECT * FROM t WHERE id={uid}")  # nosec B608', "app/db.py", "python")).toEqual([]);
  });
});

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

describe("scanSecurity — credentials by their format", () => {
  const secrets = (src: string, file = "src/a.ts", lang: Parameters<typeof scanSecurity>[2] = "typescript") =>
    scanSecurity(src, file, lang).filter((i) => i.category === "hardcoded-secret");
  // Assembled at run time so no credential-shaped literal sits in the repository.
  const aws = "AKIA" + "Q3EGRT7" + "LMNP4XYZA";
  const stripe = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";

  it("finds keys whatever the variable is called, in Python too", () => {
    expect(secrets(`const client = new Stripe("${stripe}");`)).toHaveLength(1);
    expect(secrets(`AWS_KEY_ID = "${aws}"`, "app/settings.py", "python")).toHaveLength(1);
    expect(secrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...", "deploy/key.ts")).toHaveLength(1);
    expect(secrets('const url = "postgres://admin:Pr0d-Hunter2@db.internal/app";')).toHaveLength(1);
    // A key pasted into a comment has leaked all the same.
    expect(secrets(`// old key: ${aws}`)).toHaveLength(1);
  });

  it("skips documentation values and placeholders", () => {
    expect(secrets('const id = "AKIAIOSFODNN7EXAMPLE";')).toEqual([]);
    expect(secrets('const url = "postgres://user:${DB_PASSWORD}@db/app";')).toEqual([]);
    expect(secrets('const url = "mongodb://user:password@localhost/app";')).toEqual([]);
    expect(secrets('const apiKey = "your-api-key-here";')).toEqual([]);
    expect(secrets('const password = "changeme";')).toEqual([]);
    expect(secrets('const token = "********";')).toEqual([]);
    expect(secrets('@user.update(password: "#{SecureRandom.hex}")', "app/a.rb", "ruby")).toEqual([]);
  });

  it("never prints the credential in the snippet", () => {
    const [comment] = secrets(`// old key: ${aws}`);
    expect(comment!.snippet).not.toContain(aws);
    const [url] = secrets('const url = "postgres://admin:Pr0d-Hunter2@db.internal/app";');
    expect(url!.snippet).not.toContain("Hunter2");
  });
});
