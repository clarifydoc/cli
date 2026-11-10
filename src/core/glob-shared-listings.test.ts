import { describe, it, expect, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { glob, globSync, LinkedFiles } from "./glob.js";
import { listEntries, shareDirectoryEntries, sharedEntries } from "../extractors/shared/dir-listings.js";

/**
 * The walks of one analysis share their directory listings. A listing is kept
 * as the file system gave it, so each walk still prunes, ignores and records
 * links for itself — and nothing is kept once the analysis has ended.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function league(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-listings-"));
  dirs.push(dir);
  await mkdir(join(dir, "clubs", "youth"), { recursive: true });
  await mkdir(join(dir, "matches"), { recursive: true });
  await writeFile(join(dir, "clubs", "club.ts"), "");
  await writeFile(join(dir, "clubs", "youth", "player.ts"), "");
  await writeFile(join(dir, "matches", "match.ts"), "");
  await writeFile(join(dir, "matches", "compose.yml"), "");
  return dir;
}

describe("shared directory listings", () => {
  it("a second walk reads the listings of the first and applies its own filters", async () => {
    const dir = await league();
    const end = shareDirectoryEntries();
    try {
      const all = await glob(["**/*.ts"], { cwd: dir });
      expect(all).toEqual(["clubs/club.ts", "clubs/youth/player.ts", "matches/match.ts"]);
      expect(sharedEntries(join(dir, "clubs"))?.map((e) => e.name).sort()).toEqual(["club.ts", "youth"]);

      // A file added after the first walk is not seen by the walks of the same run.
      await writeFile(join(dir, "clubs", "stadium.ts"), "");
      expect(await glob(["**/*.ts"], { cwd: dir })).toEqual(all);
      expect(globSync(["**/*.ts"], { cwd: dir })).toEqual(all);

      // Another pattern, a pruned directory and a depth limit over the same listings.
      expect(await glob(["**/*.yml"], { cwd: dir })).toEqual(["matches/compose.yml"]);
      expect(await glob(["**/*.ts"], { cwd: dir, prune: (d) => d.endsWith("youth") })).toEqual(["clubs/club.ts", "matches/match.ts"]);
      expect(await glob(["**/*.ts"], { cwd: dir, deep: 2 })).toEqual(["clubs/club.ts", "matches/match.ts"]);
      expect(await glob(["**/*.ts"], { cwd: join(dir, "clubs") })).toEqual(["club.ts", "youth/player.ts"]);
    } finally {
      end();
    }
    // The run is over: the next walk reads the tree as it is now.
    expect(sharedEntries(join(dir, "clubs"))).toBeUndefined();
    expect(await glob(["**/*.ts"], { cwd: dir })).toContain("clubs/stadium.ts");
  });

  it("links are recorded by the walk that asks for them, whichever walk read the listing", async () => {
    const dir = await league();
    await symlink(join(dir, "matches", "match.ts"), join(dir, "clubs", "fixture.ts"));
    const end = shareDirectoryEntries();
    try {
      expect(await glob(["**/*.ts"], { cwd: dir })).not.toContain("clubs/fixture.ts");
      const links = new LinkedFiles();
      expect(await glob(["**/*.ts"], { cwd: dir, links })).toContain("clubs/fixture.ts");
      expect(links.has(join(dir, "clubs", "fixture.ts"))).toBe(true);
      // The shared listing still says what the entry is.
      expect(sharedEntries(join(dir, "clubs"))?.find((e) => e.name === "fixture.ts")?.isSymbolicLink()).toBe(true);
      expect(await glob(["**/*.ts"], { cwd: dir })).not.toContain("clubs/fixture.ts");
    } finally {
      end();
    }
  });

  it("overlapping runs keep the listings until the last one ends", async () => {
    const dir = await league();
    const endFirst = shareDirectoryEntries();
    const endSecond = shareDirectoryEntries();
    expect(listEntries(join(dir, "matches")).map((e) => e.name).sort()).toEqual(["compose.yml", "match.ts"]);
    endFirst();
    endFirst();
    expect(sharedEntries(join(dir, "matches"))).toBeDefined();
    endSecond();
    expect(sharedEntries(join(dir, "matches"))).toBeUndefined();
    // Outside a run a listing is read and not kept.
    expect(listEntries(join(dir, "matches"))).toHaveLength(2);
    expect(sharedEntries(join(dir, "matches"))).toBeUndefined();
  });
});
