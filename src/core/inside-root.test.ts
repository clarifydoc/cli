import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { insideRoot } from "./inside-root.js";
import { detectDeployment } from "./deployment.js";

describe("insideRoot", () => {
  const root = join(tmpdir(), "league-root");
  it("accepts paths below the root, even through a climb that stays inside", () => {
    expect(insideRoot(root, "api/Dockerfile")).toBe(join(root, "api/Dockerfile"));
    expect(insideRoot(root, "api/../club")).toBe(join(root, "club"));
    expect(insideRoot(root, "")).toBe(root);
  });
  it("refuses climbs, drive letters, UNC and absolute spellings", () => {
    for (const p of ["../outside", "a/../../outside", "..\\outside", "a\\..\\..\\x", "//server/share", "\\\\server\\share", "C:\\garage", "c:/garage", "/etc/passwd", "~/x", "a\0b"]) {
      expect(insideRoot(root, p), p).toBeNull();
    }
  });
});

describe("detectDeployment — a build context outside the root", () => {
  for (const ctx of ["../outside", "..\\\\outside", "//server/share"]) {
    it(`never reads a Dockerfile behind \`${ctx}\``, async () => {
      const base = await mkdtemp(join(tmpdir(), "league-ctx-"));
      try {
        await mkdir(join(base, "repo"), { recursive: true });
        await mkdir(join(base, "outside"), { recursive: true });
        await writeFile(join(base, "outside", "Dockerfile"), "FROM node\nENV LEAK_FLAG=garage\nCMD [\"node\", \"car.js\"]\n");
        await writeFile(join(base, "repo", "docker-compose.yml"), `services:\n  car:\n    build: "${ctx}"\n`);
        const dep = await detectDeployment(join(base, "repo"), { subProjects: [] });
        expect(JSON.stringify(dep ?? {})).not.toContain("LEAK_FLAG");
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }
});
