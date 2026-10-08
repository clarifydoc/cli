import { describe, it, expect } from "vitest";
import { clientProxyCalls } from "./client-proxies.js";
import type { FileAnalysis } from "../types/analysis.js";

const call = (name: string, line: number) => ({ name, kind: "cross-file" as const, target: null, line });

const registry = {
  filePath: "src/main/resources/clients.xml",
  language: "springxml",
  projectId: "billing",
  imports: [],
  functions: [],
  classes: [],
  httpClientRegistrations: [{ client: "com.acme.api.PersonApi", scope: "project", proxyOf: "com.acme.api.PersonApi", line: 4 }],
} as unknown as FileAnalysis;

const caller = {
  filePath: "src/main/java/com/acme/billing/Lookup.java",
  language: "java",
  projectId: "billing",
  imports: [{ source: "com.acme.api.PersonApi", specifiers: ["PersonApi"] }],
  functions: [],
  classes: [{
    name: "Lookup",
    properties: [{ name: "personApi", type: "PersonApi" }, { name: "cache", type: "Map<String, Person>" }],
    methods: [
      { name: "find", params: [{ name: "id", type: "String" }], calls: [call("personApi.getPerson", 10), call("cache.get", 11), call("personApi.getPerson(id).getName", 12)] },
      { name: "viaParam", params: [{ name: "api", type: "PersonApi" }], calls: [call("api.createPerson", 20), call("this.personApi.deletePerson", 21)] },
    ],
  }],
} as unknown as FileAnalysis;

describe("clientProxyCalls", () => {
  it("makes each call on a proxy-typed receiver an api-call naming its operation", () => {
    expect(clientProxyCalls([registry, caller]).map((c) => [c.line, c.name, c.contract, c.baseRef])).toEqual([
      [10, "PersonApi.getPerson", { type: "com.acme.api.PersonApi", method: "getPerson" }, { kind: "client", key: "com.acme.api.PersonApi" }],
      [20, "PersonApi.createPerson", { type: "com.acme.api.PersonApi", method: "createPerson" }, { kind: "client", key: "com.acme.api.PersonApi" }],
      [21, "PersonApi.deletePerson", { type: "com.acme.api.PersonApi", method: "deletePerson" }, { kind: "client", key: "com.acme.api.PersonApi" }],
    ]);
  });

  it("finds nothing when no proxy is registered, or the type imported is another one", () => {
    expect(clientProxyCalls([caller])).toEqual([]);
    const other = { ...caller, imports: [{ source: "com.other.PersonApi", specifiers: ["PersonApi"] }] } as unknown as FileAnalysis;
    expect(clientProxyCalls([registry, other])).toEqual([]);
  });
});
