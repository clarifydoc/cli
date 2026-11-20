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

  const wrapper = (name: string) => `export function ${name}(text: string): string[] {\n  return splitTopLevel(text, { escapes: "'", dropBlank: true, trim: true, quotes: "'" });\n}\n`;
  const nested = (name: string) => `function ${name}(x: number, items: number[]): number {\n  const doubled = items.map((i) => i * 2);\n  let total = x;\n  for (const d of doubled) total += d;\n  if (total > 10) { return finish(total) }\n}\n`;
  const alternative = (name: string) => `function ${name}(text: string, other: string): string[] {\n  return splitTopLevel(text, { trim: true, dropBlank: true, quotes: "'" }) || tidy(other);\n}\n`;
  it("exempts a one-line wrapper of a shared function but not a larger body ending in a return, nor an alternative", () => {
    const run = (make: (n: string) => string) => {
      const dir = plugins({ "club/index.ts": make("a"), "player/index.ts": make("b") });
      return spawnSync("node", [script, dir, join(dir, "none.json")], { encoding: "utf8" }).status;
    };
    expect(run(wrapper)).toBe(0);
    expect(run(nested)).toBe(1);
    expect(run(alternative)).toBe(1);
  });
});
