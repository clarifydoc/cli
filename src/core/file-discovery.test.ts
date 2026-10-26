import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { discoverFiles } from "./file-discovery.js";

// A scanned repository controls its own symlinks: an analysis of a clone runs
// on whatever a git URL checks out. Discovery must neither read through a link out
// of the tree nor multiply a self-referencing one.
describe.skipIf(process.platform === "win32")("discoverFiles — symlinks", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "clarifydoc-discovery-"));
    root = join(base, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(base, "outside", "dir"), { recursive: true });
    writeFileSync(join(base, "outside", "leak.py"), "TOKEN = 'not yours'\n");
    writeFileSync(join(base, "outside", "dir", "deep.py"), "x = 1\n");
    writeFileSync(join(root, "src", "real.py"), "a = 1\n");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const paths = async () => {
    const r = await discoverFiles(root);
    return { files: r.files.map((f) => f.relativePath), skipped: r.skippedSymlinks };
  };

  it("does not read a linked file that leaves the root", async () => {
    symlinkSync(join(base, "outside", "leak.py"), join(root, "src", "leak.py"));
    const { files, skipped } = await paths();
    expect(files).toEqual(["src/real.py"]);
    expect(skipped).toEqual(["src/leak.py"]);
  });

  it("does not descend a linked directory, inside or outside the root", async () => {
    symlinkSync(join(base, "outside", "dir"), join(root, "src", "linkdir"));
    symlinkSync(join(root, "src"), join(root, "src", "loop"));
    const { files } = await paths();
    // Followed, `loop` alone would repeat every file at each of ~32 levels.
    expect(files).toEqual(["src/real.py"]);
  });

  it("skips a dangling link", async () => {
    symlinkSync(join(root, "src", "gone.py"), join(root, "src", "dangling.py"));
    const { files, skipped } = await paths();
    expect(files).toEqual(["src/real.py"]);
    expect(skipped).toEqual(["src/dangling.py"]);
  });

  it("keeps a linked file that stays inside the root", async () => {
    symlinkSync("real.py", join(root, "src", "alias.py"));
    const { files, skipped } = await paths();
    expect(files).toEqual(["src/alias.py", "src/real.py"]);
    expect(skipped).toEqual([]);
  });

  it("checks containment against the resolved root when the root path is itself a link", async () => {
    symlinkSync(root, join(base, "repo-link"));
    symlinkSync("real.py", join(root, "src", "alias.py"));
    symlinkSync(join(base, "outside", "leak.py"), join(root, "src", "leak.py"));
    const r = await discoverFiles(join(base, "repo-link"));
    expect(r.files.map((f) => f.relativePath)).toEqual(["src/alias.py", "src/real.py"]);
    expect(r.skippedSymlinks).toEqual(["src/leak.py"]);
  });
});

describe("discoverFiles — secret-looking names and skipped source directories", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-discovery-names-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, text = "x\n") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  it("reads code named like a secret, and still skips data and key files", async () => {
    write("src/password-reset.controller.ts", "export class C {}\n");
    write("src/internal/token/count.go", "package token\n");
    write("config/secrets.yaml", "openapi: 3.0.0\n");
    write(".env.local", "A=1\n");
    write("certs/server.key", "k\n");
    const r = await discoverFiles(root);
    expect(r.files.map((f) => f.relativePath)).toEqual(["src/internal/token/count.go", "src/password-reset.controller.ts"]);
    expect(r.skippedSensitive).toContain("config/secrets.yaml");
  });

  it("reads a page about a password, and still skips a page of passwords", async () => {
    write("templates/email/password-reset.html", "<p>Reset</p>\n");
    write("templates/forgot-password.html", "<p>Forgot</p>\n");
    write("export/passwords.html", "<p>x</p>\n");
    // A component's template and a migration directory named for what they handle (real-repo FP).
    write("src/app/admin/manage-club-tokens/manage-club-tokens.component.html", "<button>Revoke</button>\n");
    write("migrations/2020-01-01-000000_password-reset-token/up.sql", "CREATE TABLE password_reset (id INT);\n");
    write("deploy/secrets/league.json", "{}\n");
    // An Angular component's template named for the one password it changes.
    write("src/app/account/password/password.html", "<form>New password</form>\n");
    const r = await discoverFiles(root);
    expect(r.files.map((f) => f.relativePath)).toEqual([
      "migrations/2020-01-01-000000_password-reset-token/up.sql",
      "src/app/account/password/password.html",
      "src/app/admin/manage-club-tokens/manage-club-tokens.component.html",
      "templates/email/password-reset.html",
      "templates/forgot-password.html",
    ]);
    expect(r.skippedSensitive.sort()).toEqual(["deploy/secrets/league.json", "export/passwords.html"]);
  });

  it("skips a build tool's build/ output, not a package or a build project named build (real-repo FP)", async () => {
    write("league-api/pom.xml", "<project/>\n");
    write("league-api/src/main/java/com/example/league/build/ApiResolver.java", "package com.example.league.build;\nclass ApiResolver {}\n");
    write("league-api/build/generated/Stub.java", "class Stub {}\n");
    write("garage-ui/package.json", "{}\n");
    write("garage-ui/build/static/main.js", "console.log(1);\n");
    write("tools/build/_build.csproj", "<Project/>\n");
    write("tools/build/Build.cs", "class Build {}\n");
    write("build/output.js", "x();\n");
    const r = await discoverFiles(root);
    const files = r.files.map((f) => f.relativePath);
    expect(files).toEqual(expect.arrayContaining(["league-api/src/main/java/com/example/league/build/ApiResolver.java", "tools/build/Build.cs"]));
    expect(files.filter((f) => /(?:^|\/)build\/(?:generated|static|output)/.test(f))).toEqual([]);
  });

  it("reads a Rust crate's src/bin and a package's declared bin/, not other bin/ folders", async () => {
    write("server/Cargo.toml", "[package]\nname = \"s\"\n");
    write("server/src/main.rs", "fn main() {}\n");
    write("server/src/bin/admin.rs", "fn main() {}\n");
    write("tool/package.json", '{ "name": "t", "bin": { "t": "bin/t.js" } }\n');
    write("tool/bin/t.js", "console.log(1)\n");
    write("lib/package.json", '{ "name": "l" }\n');
    write("lib/bin/build-output.js", "x\n");
    write("App/bin/Debug/Gen.cs", "class G {}\n");
    const files = (await discoverFiles(root)).files.map((f) => f.relativePath);
    expect(files).toContain("server/src/bin/admin.rs");
    expect(files).toContain("tool/bin/t.js");
    expect(files).not.toContain("lib/bin/build-output.js");
    expect(files).not.toContain("App/bin/Debug/Gen.cs");
  });
});

describe("discoverFiles — a hand-written types package", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-dts-"));
    mkdirSync(join(root, "types"), { recursive: true });
    writeFileSync(join(root, "types", "package.json"), JSON.stringify({ name: "@league/match-events", types: "index.d.ts" }));
    writeFileSync(join(root, "types", "index.d.ts"), "export * from './Match';\n");
    writeFileSync(join(root, "types", "Match.d.ts"), "export interface Match { id: string }\n");
    mkdirSync(join(root, "app", "dist"), { recursive: true });
    writeFileSync(join(root, "app", "package.json"), JSON.stringify({ name: "league-app", main: "dist/index.js", types: "dist/index.d.ts" }));
    writeFileSync(join(root, "app", "club.ts"), "export const club = 1;\n");
    writeFileSync(join(root, "app", "club.d.ts"), "export declare const club: number;\n");
    writeFileSync(join(root, "app", "dist", "index.d.ts"), "export {};\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads the declaration files of a package that ships only types, never a compiled package's", async () => {
    const files = (await discoverFiles(root)).files.filter((f) => !f.relativePath.endsWith(".json")).map((f) => `${f.relativePath} ${f.language}`);
    expect(files).toEqual(["app/club.ts typescript", "types/Match.d.ts typescript", "types/index.d.ts typescript"]);
  });
});
