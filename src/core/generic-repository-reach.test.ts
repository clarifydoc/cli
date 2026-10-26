import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A generic repository reads through `_database.Query<TModel>(…)`: the table is
 * the type a caller closes `TModel` over, bound along the call chain — through an
 * interface whose implementation closes the base, and through a generic service
 * a subclass closes (real-repo FP: provider routes ending in the base repository
 * reached no table).
 */
const FILES: Record<string, string> = {
  "League.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
  "Data/BasicRepository.cs": `namespace League.Data
{
    public interface IBasicRepository<TModel> where TModel : ModelBase
    {
        List<TModel> All();
    }

    public class BasicRepository<TModel> : IBasicRepository<TModel> where TModel : ModelBase
    {
        protected readonly IDatabase _database;

        public BasicRepository(IDatabase database)
        {
            _database = database;
        }

        protected List<TModel> Query(SqlBuilder builder) => _database.Query<TModel>(builder).ToList();

        public List<TModel> All()
        {
            return Query(new SqlBuilder());
        }
    }
}
`,
  "Data/Club.cs": `namespace League.Data
{
    [Table("clubs")]
    public class Club : ModelBase
    {
        public string Name { get; set; }
    }

    [Table("cars")]
    public class Car : ModelBase
    {
        public string Plate { get; set; }
    }
}
`,
  "Clubs/ClubRepository.cs": `using League.Data;

namespace League.Clubs
{
    public interface IClubRepository : IBasicRepository<Club> { }

    public class ClubRepository : BasicRepository<Club>, IClubRepository
    {
        public ClubRepository(IDatabase database) : base(database) { }
    }
}
`,
  "Clubs/ClubService.cs": `namespace League.Clubs
{
    public class ClubService
    {
        private readonly IClubRepository _clubs;

        public ClubService(IClubRepository clubs)
        {
            _clubs = clubs;
        }

        public List<Club> AllClubs()
        {
            return _clubs.All();
        }
    }
}
`,
  "Garage/GarageService.cs": `using League.Data;

namespace League.Garage
{
    public abstract class GarageService<TVehicle> where TVehicle : ModelBase
    {
        private readonly IBasicRepository<TVehicle> _vehicles;

        protected GarageService(IBasicRepository<TVehicle> vehicles)
        {
            _vehicles = vehicles;
        }

        public List<TVehicle> Parked()
        {
            return _vehicles.All();
        }
    }

    public class CarGarageService : GarageService<Car>
    {
        public CarGarageService(IBasicRepository<Car> cars) : base(cars) { }
    }
}
`,
  "Api/LeagueController.cs": `using Microsoft.AspNetCore.Mvc;
using League.Clubs;
using League.Garage;

namespace League.Api
{
    [ApiController]
    [Route("api/v2")]
    public class LeagueController : ControllerBase
    {
        private readonly ClubService _clubService;
        private readonly CarGarageService _garage;

        public LeagueController(ClubService clubService, CarGarageService garage)
        {
            _clubService = clubService;
            _garage = garage;
        }

        [HttpGet("clubs")]
        public IActionResult GetClubs() => Ok(_clubService.AllClubs());

        [HttpGet("cars")]
        public IActionResult GetCars() => Ok(_garage.Parked());
    }
}
`,
};

describe("a generic repository's reads, bound along the call chain", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-generic-repo-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reach the table each route's caller closes the repository over", () => {
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.effect} ${f.resource}`).sort();
    expect(flows).toEqual(["GET /api/v2/cars db-read Car", "GET /api/v2/clubs db-read Club"]);
  });

  it("name every hop down to the generic read", () => {
    const flow = (summary.dataFlows ?? []).find((f) => f.entryLabel === "GET /api/v2/cars");
    expect(flow?.via?.map((h) => h.symbol)).toEqual([
      "route:GET /api/v2/cars", "LeagueController.GetCars", "GarageService.Parked", "BasicRepository.All", "BasicRepository.Query",
    ]);
  });

  it("leaves the generic method itself without a table", () => {
    const reach = (summary.symbolReach ?? []).find((r) => r.symbol === "BasicRepository.All");
    expect(reach?.effects ?? []).toEqual([]);
    expect(summary.symbolLinks?.some((l) => "typeArgs" in l)).toBe(false);
  });
});
