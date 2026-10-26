import { describe, it, expect } from "vitest";
import { analyzeFile } from "./file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

async function callKinds(src: string, rel: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "dbroot-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "dbroot-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "java" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  const a = result!.analysis;
  return [...a.functions, ...a.classes.flatMap((c) => c.methods)].flatMap((f) => f.calls).map((c) => `${c.name} ${c.kind}`).sort();
}

/** A DB root that is also a common variable name counts only when declared as a database type (real-repo FP shape). */
describe("dbRootTypes", () => {
  it("drops a framework session's calls, keeps a Hibernate session's", async () => {
    const kinds = await callKinds(`package com.example.league;

import com.example.platform.LeagueSession;

public class ClubAdmin {
    private final LeagueSession session;

    public ClubAdmin(LeagueSession session) { this.session = session; }

    public Object clubs() {
        return session.clubs().getAll();
    }

    public void store(org.hibernate.Session session, Object club) {
        session.save(club);
    }
}
`, "src/main/java/com/example/league/ClubAdmin.java");
    expect(kinds.filter((k) => k.startsWith("session."))).toEqual([
      "session.clubs internal",
      "session.clubs().getAll internal",
      "session.save database",
    ]);
  });
});
