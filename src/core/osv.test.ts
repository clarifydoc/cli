import { describe, it, expect } from "vitest";
import { attachOsvAdvisories } from "./osv.js";
import type { ExternalPackage } from "../types/analysis.js";

const pkg = (name: string, ecosystem: ExternalPackage["ecosystem"], version: string | null, resolvedVersion?: string): ExternalPackage =>
  ({ name, ecosystem, version, scope: "prod", category: "other", declaredIn: "package.json", ...(resolvedVersion ? { resolvedVersion } : {}) }) as ExternalPackage;

describe("attachOsvAdvisories", () => {
  it("asks only about exact versions and records advisories with OSV's own severity", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fake = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith("/v1/querybatch")) {
        return { ok: true, json: async () => ({ results: [{ vulns: [{ id: "GHSA-p6mc-m468-83gw" }] }, {}] }) };
      }
      return { ok: true, json: async () => ({ summary: "Prototype pollution in lodash", aliases: ["CVE-2020-8203"], database_specific: { severity: "HIGH" }, severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/…" }] }) };
    }) as unknown as typeof fetch;
    const lodash = pkg("lodash", "npm", "^4.17.0", "4.17.15");
    const express = pkg("express", "npm", "4.18.2");
    const ranged = pkg("react", "npm", "^18.2.0");
    const result = await attachOsvAdvisories([lodash, express, ranged], { fetch: fake });
    expect(result).toEqual({ asked: 2, vulnerable: 1 });
    // A range is never queried by its lower bound.
    expect((calls[0]!.body as { queries: unknown[] }).queries).toEqual([
      { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.15" },
      { package: { name: "express", ecosystem: "npm" }, version: "4.18.2" },
    ]);
    expect(lodash.advisories).toEqual([{ id: "GHSA-p6mc-m468-83gw", summary: "Prototype pollution in lodash", severity: "HIGH", aliases: ["CVE-2020-8203"] }]);
    expect(express.advisories).toBeUndefined();
  });

  it("never fails the analysis when OSV is unreachable", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const p = pkg("lodash", "npm", "4.17.15");
    expect(await attachOsvAdvisories([p], { fetch: down })).toEqual({ asked: 1, vulnerable: 0, error: "offline" });
    expect(p.advisories).toBeUndefined();
  });
});
