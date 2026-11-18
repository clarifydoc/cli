import { describe, it, expect } from "vitest";
import { runCarets } from "./caret-testkit.js";

const DB = `using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;

public class LeagueDb : DbContext {
    public DbSet<StadiumTicket> StadiumTickets { get; set; }
    public DbSet<DecoyRow> DecoyRows { get; set; }
}

public class StadiumTicket { public int Id { get; set; } }
public class DecoyRow { public int Id { get; set; } }
`;

const GATE = `using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.EntityFrameworkCore;

public class StadiumAuthorizationFilter(LeagueDb db) : IAsyncAuthorizationFilter {
    public async Task OnAuthorizationAsync(AuthorizationFilterContext context) {
        await db.StadiumTickets.FirstOrDefaultAsync();
    }
}
`;

const DECOY = `using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.EntityFrameworkCore;

public class UnusedGateFilter(LeagueDb db) : IAsyncAuthorizationFilter {
    public async Task OnAuthorizationAsync(AuthorizationFilterContext context) {
        await db.DecoyRows.FirstOrDefaultAsync();
    }
}
`;

const API = `using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
[ServiceFilter(typeof(StadiumAuthorizationFilter))]
public class FixturesController : ControllerBase {
    [HttpGet("{id}")]
    public Task<int> Get(int id) => Task.FromResult(id);
}
`;

describe("ASP.NET ServiceFilter middleware reach", () => {
  it("joins what the filter reads to the route, not a decoy filter", async () => {
    const { analysis } = await runCarets({
      "LeagueApi.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
      "Data/LeagueDb.cs": DB,
      "Filters/StadiumAuthorizationFilter.cs": GATE,
      "Filters/UnusedGateFilter.cs": DECOY,
      "Api/FixturesController.cs": API,
    });
    const flows = (analysis.dataFlows ?? [])
      .map((f) => `${f.entryLabel} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`)
      .sort();
    expect(flows).toEqual(["GET /api/Fixtures/{id} StadiumTicket (middleware)"]);
  });
});