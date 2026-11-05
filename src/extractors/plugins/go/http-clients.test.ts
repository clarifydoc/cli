import { describe, expect, it } from "vitest";
import { extractGoDataSources } from "./data-sources.js";
import { extractGoModuleValues } from "./module-values.js";

const lines = (s: string) => s.split("\n");

describe("Go outbound HTTP", () => {
  it("reads a resty request chain as a call with its verb and URL", () => {
    const src = `package main
import "github.com/go-resty/resty/v2"
func a() {
  client := resty.New()
  client.R().SetBody("x").Post("https://league.example.com/players")
  client.R().Get("/clubs")
}`;
    const calls = extractGoDataSources(lines(src)).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => [c.name, c.target])).toEqual([["POST", "https://league.example.com/players"], ["GET", "/clubs"]]);
  });

  it("reads a resty chain split over lines, at the line of its verb, and no chain without one", () => {
    const src = `package main
import "github.com/go-resty/resty/v2"
func a() {
  client := resty.New()
  client.R().
    SetBody(x).
    Post("/api/clubs")
  client.R().
    SetHeader("a", "b").
    SetResult(&r).
    Get("/api/players")
  other.R().
    Foo("/api/decoy")
  done := true
}`;
    const calls = extractGoDataSources(lines(src)).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => [c.name, c.target, c.line])).toEqual([["POST", "/api/clubs", 7], ["GET", "/api/players", 11]]);
  });

  it("does not read .R().Get without resty in the file", () => {
    const calls = extractGoDataSources(lines(`package main\nfunc a() { r.R().Get("/x") }`)).filter((d) => d.kind === "api-call");
    expect(calls).toEqual([]);
  });

  it("keeps a package constant that holds a URL (its `//` is no comment)", () => {
    expect(extractGoModuleValues(lines(`package main\nconst baseURL = "https://league.example.com/api" // the league\n`)))
      .toEqual({ baseURL: "https://league.example.com/api" });
  });
});
