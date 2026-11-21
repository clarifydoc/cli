import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** OSV answers are injected: no network. Each advisory is stated the way OSV's Go records state them. */
const advisories: Record<string, unknown> = {
  "GO-2026-0001": {
    summary: "Garage parser reads past its buffer",
    affected: [{ package: { name: "example.com/garagekit", ecosystem: "Go" }, ecosystem_specific: { imports: [{ path: "example.com/garagekit", symbols: ["ParseCar", "Decoder.Decode", "scan"] }] } }],
  },
  "GO-2026-0002": {
    summary: "Tyre pump overflow",
    affected: [{ package: { name: "example.com/tyrekit", ecosystem: "Go" }, ecosystem_specific: { imports: [{ path: "example.com/tyrekit", symbols: ["Inflate"] }] } }],
  },
  "GO-2026-0003": {
    summary: "Pit radio leaks",
    affected: [{ package: { name: "example.com/radiokit", ecosystem: "Go" }, ecosystem_specific: { imports: [{ path: "example.com/radiokit", symbols: ["Server.Serve"] }] } }],
  },
  "GHSA-pkg-only": { summary: "Package level only", affected: [{ package: { name: "example.com/paintkit", ecosystem: "Go" } }] },
};
const byPackage: Record<string, string> = {
  "example.com/garagekit": "GO-2026-0001", "example.com/tyrekit": "GO-2026-0002", "example.com/radiokit": "GO-2026-0003", "example.com/paintkit": "GHSA-pkg-only",
};
const fakeFetch = (async (url: string, init?: { body?: string }) => {
  if (url.endsWith("/v1/querybatch")) {
    const queries = JSON.parse(init!.body!).queries as Array<{ package: { name: string } }>;
    return { ok: true, json: async () => ({ results: queries.map((q) => ({ vulns: [{ id: byPackage[q.package.name] }] })) }) };
  }
  const id = decodeURIComponent(url.split("/").pop()!);
  return { ok: true, json: async () => advisories[id] };
}) as unknown as typeof fetch;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("vulnerable-function reachability", () => {
  it("reports a vulnerable function a route reaches with its path, and not one nothing calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarifydoc-vuln-"));
    const out = mkdtempSync(join(tmpdir(), "clarifydoc-vuln-out-"));
    dirs.push(root, out);
    writeFileSync(join(root, "go.mod"), `module example.com/league

go 1.21

require (
	example.com/garagekit v1.2.0
	example.com/tyrekit v0.4.1
	example.com/radiokit v2.0.0
	example.com/paintkit v1.0.0
	github.com/gin-gonic/gin v1.9.1
)
`);
    mkdirSync(join(root, "garage"));
    writeFileSync(join(root, "garage", "intake.go"), `package garage

import "example.com/garagekit"

// Register is called from the route handler below.
func Register(raw []byte) any {
	return garagekit.ParseCar(raw)
}
`);
    writeFileSync(join(root, "main.go"), `package main

import (
	"example.com/league/garage"
	"example.com/radiokit"
	"example.com/tyrekit"
	"github.com/gin-gonic/gin"
)

func addCar(c *gin.Context) {
	raw, _ := c.GetRawData()
	c.JSON(200, garage.Register(raw))
}

// Decoy: the same package, a different function than the vulnerable one.
func pumpStatus(c *gin.Context) {
	c.JSON(200, tyrekit.Gauge())
}

func startRadio() {
	radiokit.Listen()
}

func main() {
	r := gin.Default()
	r.POST("/cars", addCar)
	r.GET("/pump", pumpStatus)
	r.Run()
}
`);
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true, osv: true, osvFetch: fakeFetch });
    const summary = (await loadReportSummary(out)) as unknown as { externalPackages: Array<{ name: string; advisories?: Array<{ id: string; reach?: { status: string; calls?: Array<{ symbol: string; from?: string; path?: string[] }> } }> }> };
    const adv = (name: string) => summary.externalPackages.find((p) => p.name === name)?.advisories?.[0];

    const garage = adv("example.com/garagekit")!;
    expect(garage.reach?.status).toBe("reachable");
    expect(garage.reach?.calls?.[0]).toMatchObject({ symbol: "ParseCar", from: "POST /cars" });
    expect(garage.reach?.calls?.[0]?.path?.map((k) => k.split("::")[1])).toEqual(["addCar", "Register"]);

    // The decoy calls Gauge, not the vulnerable Inflate.
    expect(adv("example.com/tyrekit")?.reach).toEqual({ status: "not-called" });
    // Only a method is named: a package-qualified call cannot be told from other receivers.
    expect(adv("example.com/radiokit")?.reach).toEqual({ status: "not-judged" });
    // No function data: the advisory stays package-level.
    expect(adv("example.com/paintkit")?.reach).toBeUndefined();
  }, 60000);
});
