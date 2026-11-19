import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

async function summaryOf(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-blocking-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const flagged = (summary: ProjectAnalysis): string[] =>
  (summary.patterns ?? []).filter((p) => p.kind === "blocking-in-async").map((p) => p.detail.split("()")[0]!);

const LEAGUE = `using System.Threading.Tasks;
namespace League {
  public class Club { public int Result { get; set; } public void Wait() {} }
  public class ClubRepo {
    public Task<Club> FindAsync(int id) { return Task.FromResult(new Club()); }
  }
  public class Service {
    private readonly ClubRepo _repo;
    private Task _pending;
    public async Task Promote(Task<Club> param, Task plain) {
      var t = _repo.FindAsync(1);
      t.Wait();
      param.Wait();
      plain.Wait();
      _pending.Wait();
      var club = new Club();
      club.Wait();
      Club other = club;
      other.Wait();
      await Task.Delay(1);
    }
    public void Sync(Task<Club> param) { param.Wait(); }
  }
}
`;

describe("C# receiver-typed blocking calls", () => {
  let summary: ProjectAnalysis;
  let cleanup = async () => {};
  beforeAll(async () => ({ summary, cleanup } = await summaryOf({ "League.cs": LEAGUE })), 120000);
  afterAll(async () => cleanup());
  it("flags Wait on a Task and nothing else", () => {
    expect(flagged(summary).sort()).toEqual(["_pending.Wait", "param.Wait", "plain.Wait", "t.Wait"]);
  });
});

describe("C# project class named Task", () => {
  let summary: ProjectAnalysis;
  let cleanup = async () => {};
  beforeAll(async () => ({ summary, cleanup } = await summaryOf({
    "Task.cs": `namespace League { public class Task { public void Wait() {} } }
namespace League { public class Runner { public async System.Threading.Tasks.Task Go(Task job) { job.Wait(); } } }`,
  })), 120000);
  afterAll(async () => cleanup());
  it("flags nothing", () => expect(flagged(summary)).toEqual([]));
});
