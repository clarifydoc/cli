import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "check-plugin-helpers.mjs");

const HELPER = `
function lastSegment(path: string, separator: string): string {
  const parts = path.split(separator).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : "";
}
`;

function plugins(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "plugin-helpers-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

describe("check-plugin-helpers", () => {
  it("passes on the plugin folders as they are", () => {
    expect(execFileSync("node", [script], { encoding: "utf8" })).toContain("no identical body");
  });

  it("fails on one helper body declared in two plugin folders, whatever it is named", () => {
    const dir = plugins({ "club/index.ts": HELPER, "player/index.ts": HELPER.replace("lastSegment", "tail") });
    const run = spawnSync("node", [script, dir, join(dir, "none.json")], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("club/index.ts  lastSegment");
    expect(run.stderr).toContain("player/index.ts  tail");
  });

  it("accepts the body when the allow-list names it, and ignores two copies in one folder", () => {
    const dir = plugins({ "club/index.ts": HELPER, "player/index.ts": HELPER });
    const first = spawnSync("node", [script, dir, join(dir, "none.json")], { encoding: "utf8" });
    const hash = /^ {2}([0-9a-f]{12})$/m.exec(first.stderr)![1]!;
    writeFileSync(join(dir, "allow.json"), JSON.stringify({ [hash]: "left on purpose" }));
    expect(spawnSync("node", [script, dir, join(dir, "allow.json")], { encoding: "utf8" }).status).toBe(0);
    const same = plugins({ "club/a.ts": HELPER, "club/b.ts": HELPER });
    expect(spawnSync("node", [script, same, join(same, "none.json")], { encoding: "utf8" }).status).toBe(0);
  });
});
