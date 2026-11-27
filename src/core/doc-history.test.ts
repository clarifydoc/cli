import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitPathHistory } from "./doc-history.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });

/** A repository where one car file was deleted and one garage file renamed. */
function league(): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "doc-history-"));
  dirs.push(root);
  const out = join(root, ".out");
  mkdirSync(out);
  git(root, "init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/car.ts"), "export const car = 1;\n");
  writeFileSync(join(root, "src/garage.ts"), "export const garage = 2;\n");
  git(root, "add", "src");
  git(root, "commit", "-qm", "cars");
  git(root, "rm", "-q", "src/car.ts");
  git(root, "mv", "src/garage.ts", "src/garage-new.ts");
  git(root, "commit", "-qm", "tidy");
  return { root, out };
}

describe("gitPathHistory", () => {
  it("names the commit that deleted a path and the file a rename went to", () => {
    const { root } = league();
    const history = gitPathHistory(root)!;
    expect(history("src/car.ts")?.deletedIn).toMatch(/^[0-9a-f]+ \(\d{4}-\d\d-\d\d\)$/);
    expect(history("src/garage.ts")).toEqual({ renamedTo: "src/garage-new.ts" });
    expect(history("src/never.ts")).toBeNull();
  });

  it("keeps its answers for the next run while HEAD is the same, and drops them when it moves", () => {
    const { root, out } = league();
    const first = gitPathHistory(root, out)!;
    const car = first("src/car.ts");
    first("src/never.ts");
    first.save();
    const cache = join(out, ".doc-history.json");
    expect(JSON.parse(readFileSync(cache, "utf-8")).answers).toEqual({ "src/car.ts": car, "src/never.ts": null });
    // An answer read from the cache is not asked of git: a planted one comes back as written.
    const planted = JSON.parse(readFileSync(cache, "utf-8"));
    planted.answers["src/never.ts"] = { deletedIn: "planted" };
    writeFileSync(cache, JSON.stringify(planted));
    expect(gitPathHistory(root, out)!("src/never.ts")).toEqual({ deletedIn: "planted" });
    // A new commit is a new history: the cache is not read.
    git(root, "commit", "-q", "--allow-empty", "-m", "next");
    expect(gitPathHistory(root, out)!("src/never.ts")).toBeNull();
  });

  it("writes nothing when no question was asked or all were answered by the cache", () => {
    const { root, out } = league();
    gitPathHistory(root, out)!.save();
    expect(existsSync(join(out, ".doc-history.json"))).toBe(false);
  });

  it("asks nothing outside a work tree or before the first commit", () => {
    const plain = mkdtempSync(join(tmpdir(), "doc-history-plain-"));
    dirs.push(plain);
    expect(gitPathHistory(plain)).toBeUndefined();
    git(plain, "init", "-q");
    expect(gitPathHistory(plain)).toBeUndefined();
  });
});
