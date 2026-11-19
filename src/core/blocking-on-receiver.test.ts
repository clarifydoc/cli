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

const RESULTS = `using System.Threading.Tasks;
namespace League {
  public class Club { public int Result { get; set; } }
  public class Report { public Club Result { get; set; } }
  public class ClubRepo {
    public Task<Club> FindAsync(int id) { return Task.FromResult(new Club()); }
    public Club Find(int id) { return new Club(); }
    public Report Summary() { return new Report(); }
  }
  public class Service {
    private readonly ClubRepo _repo;
    private Task<Club> _pending;
    public async Task Promote(Task<Club> param, Club club) {
      var t = _repo.FindAsync(1);
      var a = t.Result;
      var b = param.Result;
      var c = _pending.Result;
      var d = this._pending.Result;
      var e = _repo.FindAsync(2).Result;
      var f = club.Result;
      var g = _repo.Summary().Result;
      var h = _repo.Find(3).Result;
      await Task.Delay(1);
    }
    public async Task Completed(Task<Club> one, Task<Club> two) {
      await Task.WhenAll(one, two);
      var x = one.Result;
      var y = two.ContinueWith(t => t.Result);
    }
    public async Task Typed() { var z = Task.Run(() => _repo.FindAsync(4).Result); await z; }
    public int Sync(Task<Club> param) { return param.Result.Result; }
  }
}
`;

describe("C# .Result on a Task inside an async method", () => {
  let summary: ProjectAnalysis;
  let cleanup = async () => {};
  beforeAll(async () => ({ summary, cleanup } = await summaryOf({ "League.cs": RESULTS })), 120000);
  afterAll(async () => cleanup());
  const reads = (): string[] =>
    (summary.patterns ?? []).filter((p) => p.kind === "blocking-in-async").map((p) => p.detail.split(" (a property read)")[0]!).sort();
  it("flags the reads whose receiver is a Task and nothing else", () => {
    expect(reads()).toEqual(["_pending.Result", "_repo.FindAsync().Result", "param.Result", "t.Result", "this._pending.Result"]);
  });
});

describe("C# Wait chained on a call's result", () => {
  let summary: ProjectAnalysis;
  let cleanup = async () => {};
  beforeAll(async () => ({ summary, cleanup } = await summaryOf({
    "League.cs": `using System.Threading.Tasks;
namespace League {
  public class Club { public void Wait() {} }
  public class ClubRepo {
    public Task SaveAsync() { return null; }
    public Club Find(int id) { return new Club(); }
  }
  public class Service {
    private readonly ClubRepo _repo;
    public async Task Go() { _repo.SaveAsync().Wait(); _repo.Find(1).Wait(); await Task.Delay(1); }
  }
}
`,
  })), 120000);
  afterAll(async () => cleanup());
  it("flags the Task a method returns, never a project class's Wait", () => {
    expect(flagged(summary)).toEqual(["_repo.SaveAsync"]);
  });
});
