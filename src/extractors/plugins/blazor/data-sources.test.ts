import { describe, it, expect } from "vitest";
import { extractBlazorDataSources } from "./data-sources.js";

describe("Blazor @code HTTP calls", () => {
  const lines = `@page "/clubs"
@inject HttpClient Http
@inject ClubRepo Repo
@code {
    private async Task Promote()
    {
        await Http.PostAsync($"/api/clubs/{Name}/promote", null);
        var all = await Http.GetFromJsonAsync<List<Club>>("api/clubs?active=true");
        await Repo.GetAsync("/api/decoy");
        await Http.GetStringAsync(url);
    }
}`.split("\n");
  it("reads literal URLs on an injected HttpClient only", () => {
    const rows = extractBlazorDataSources(lines, []);
    expect(rows.map((r) => `${r.name}@${r.line}`)).toEqual(["POST /api/clubs/{Name}/promote@7", "GET /api/clubs@8"]);
  });
  it("gives nothing without a declared HttpClient", () => {
    expect(extractBlazorDataSources(["@code { await Http.GetAsync(\"/x\"); }"], [])).toEqual([]);
  });
});
