import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * A file its plugin refuses by content (a JSON file that is not an API spec) has no analysis to
 * cache. The manifest remembers the refusal by hash, so the next incremental run neither hands the
 * file to a plugin again nor reports it as changed.
 */
describe("incremental runs and files a plugin refuses", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-refused-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-refused-out-"));
  afterAll(() => {
    for (const dir of [root, out]) rmSync(dir, { recursive: true, force: true });
  });

  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", JSON.stringify({ name: "garage", dependencies: {} }));
  write("locales/en.json", JSON.stringify({ club: "Club", player: "Player" }));
  write("src/clubs.ts", "export function listClubs() {\n  return fetch('/api/v2/clubs');\n}\n");

  const run = () => analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, incremental: true, stableOutput: true });
  const manifest = () =>
    JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")) as { entries: Record<string, unknown>; skipped?: Record<string, unknown> };

  it("records the refusal apart from the analyzed files", async () => {
    const first = await run();
    expect(first.files).not.toContain("locales/en.json");
    expect(Object.keys(manifest().skipped ?? {})).toContain("locales/en.json");
    expect(manifest().entries).not.toHaveProperty("locales/en.json");
  });

  it("reports only the edited file as changed on the next run", async () => {
    write("src/clubs.ts", "export function listClubs() {\n  return fetch('/api/v2/clubs?page=1');\n}\n");
    const next = await run();
    expect(next.changedFiles).toEqual(["src/clubs.ts"]);
    expect(Object.keys(manifest().skipped ?? {})).toContain("locales/en.json");
  });

  it("hands the file to its plugin again once its bytes change", async () => {
    write("locales/en.json", JSON.stringify({ openapi: "3.0.0", info: { title: "League", version: "1" }, paths: { "/api/v2/clubs": { get: { responses: { 200: { description: "ok" } } } } } }));
    const next = await run();
    expect(next.changedFiles).toContain("locales/en.json");
    expect(next.files).toContain("locales/en.json");
    expect(manifest().entries).toHaveProperty("locales/en.json");
    expect(manifest().skipped ?? {}).not.toHaveProperty("locales/en.json");
  });
});
