import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** A receiver declared with a type alias reaches the aliased class's member. */
describe("type aliases followed for receivers", () => {
  let dir: string;
  const files: Record<string, string> = {
    "web/package.json": `{ "name": "garage-web" }`,
    "web/src/repo.ts": `export class ClubRepository { save(): void {} }`,
    "web/src/types.ts": `import { ClubRepository } from "./repo";\nexport type Repo = ClubRepository | null;`,
    "web/src/garage.ts": `import { Repo } from "./types";\nexport class Garage {\n  constructor(private repo: Repo) {}\n  park(): void { this.repo.save(); }\n}`,
    "pit/pyproject.toml": `[project]\nname = "pit"`,
    "pit/pit/repo.py": `class ClubRepository:\n    def save(self):\n        pass\n\nRepo = ClubRepository\n`,
    "pit/pit/stop.py": `from pit.repo import Repo\n\ndef run(repo: Repo):\n    repo.save()\n`,
    "svc/go.mod": `module example.com/svc\n\ngo 1.22\n`,
    "svc/store/repo.go": `package store\n\ntype ClubRepo struct{}\n\nfunc (r *ClubRepo) Save() error { return nil }\n\ntype Repo = ClubRepo\n`,
    "svc/handler/match.go": `package handler\n\nimport "example.com/svc/store"\n\ntype MatchHandler struct {\n\trepo *store.Repo\n}\n\nfunc (h *MatchHandler) Create() {\n\th.repo.Save()\n}\n`,
    "api/Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
    "api/ClubRepository.cs": `namespace League.Data;\npublic class ClubRepository { public void Save() {} }`,
    "api/MatchService.cs": `using Clubs = League.Data.ClubRepository;\nnamespace League.Services;\npublic class MatchService {\n  public void Play(Clubs clubs) { clubs.Save(); }\n}`,
    "api/Scoring.cs": `namespace League.Scoring;\npublic static class Calc { public static int Add(int a, int b) => a + b; }`,
    "api/Table.cs": `using ScoreCalc = League.Scoring.Calc;\nnamespace League.Services;\npublic class Table {\n  public int Points() { return ScoreCalc.Add(1, 2); }\n}`,
    "api/TransferService.cs": `namespace League.Services;\npublic class TransferService {\n  public void Move(Clubs clubs) { clubs.Save(); }\n}`,
    "core/Cargo.toml": `[package]\nname = "core"\nversion = "0.1.0"`,
    "core/src/store.rs": `pub struct ClubStore;\nimpl ClubStore {\n    pub fn save(&self) {}\n}\npub type Store = std::sync::Arc<ClubStore>;\n`,
    "core/src/service.rs": `use crate::store::Store;\npub struct MatchService { store: Store }\nimpl MatchService {\n    pub fn play(&self) { self.store.save(); }\n}\n`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-alias-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links a call on an alias-typed field, parameter or local to the class the alias names", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const reach = (from: string, call: string) =>
      summary.symbolLinks.filter((l) => l.sourceFile === from && l.callName === call).map((l) => `${l.targetFile}::${l.targetSymbol}`);
    expect(reach("web/src/garage.ts", "this.repo.save")).toEqual(["web/src/repo.ts::ClubRepository.save"]);
    expect(reach("pit/pit/stop.py", "repo.save")).toEqual(["pit/pit/repo.py::ClubRepository.save"]);
    expect(reach("svc/handler/match.go", "repo.Save")).toEqual(["svc/store/repo.go::ClubRepo.Save"]);
    expect(reach("api/MatchService.cs", "clubs.Save")).toEqual(["api/ClubRepository.cs::ClubRepository.Save"]);
    expect(reach("core/src/service.rs", "store.save")).toEqual(["core/src/store.rs::ClubStore.save"]);
    expect(reach("api/Table.cs", "ScoreCalc.Add")).toEqual(["api/Scoring.cs::Calc.Add"]);
    // A C# `using` alias names the type only in its own file.
    expect(reach("api/TransferService.cs", "clubs.Save")).toEqual([]);
  });
});
