import { describe, it, expect } from "vitest";
import { clientProxyCalls, proxiedOnlyTypes } from "./client-proxies.js";
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

  it("takes the receiver type a plugin states for a proxy built in the call chain", () => {
    const chained = {
      ...caller,
      classes: [{
        name: "Lookup",
        properties: [],
        methods: [{ name: "find", params: [], calls: [
          { ...call("JAXRSClientFactory.fromClient(client, PersonApi.class, true).getPerson", 30), receiverType: "PersonApi" },
          { ...call("ctx.getBean(Cache.class).get", 31), receiverType: "Cache" },
        ] }],
      }],
    } as unknown as FileAnalysis;
    expect(clientProxyCalls([registry, chained]).map((c) => [c.line, c.name, c.contract])).toEqual([
      [30, "PersonApi.getPerson", { type: "com.acme.api.PersonApi", method: "getPerson" }],
    ]);
  });

  it("follows a method of the class declared to return the proxy", () => {
    const helper = {
      ...caller,
      classes: [{
        name: "Lookup",
        properties: [],
        methods: [
          { name: "find", params: [], calls: [call("personService(id).getPerson", 40), call("this.personService(id).getPerson(id).getName", 41), call("cache(id).get", 42)] },
          { name: "personService", params: [{ name: "id", type: "String" }], returnType: "PersonApi", calls: [] },
          { name: "cache", params: [], returnType: "Map<String, Person>", calls: [] },
        ],
      }],
    } as unknown as FileAnalysis;
    expect(clientProxyCalls([registry, helper]).map((c) => [c.line, c.name])).toEqual([[40, "PersonApi.getPerson"]]);
  });
});

describe("proxiedOnlyTypes", () => {
  it("names a proxied API interface no class of the project implements (real-repo FP)", () => {
    const leagueRegistry = { ...registry, httpClientRegistrations: [
      ...registry.httpClientRegistrations!,
      { client: "com.acme.api.LeagueApi", scope: "project", proxyOf: "com.acme.api.LeagueApi", line: 9 },
    ] } as FileAnalysis;
    const server = { ...caller, filePath: "src/main/java/com/acme/billing/LeagueApiImpl.java", classes: [{ name: "LeagueApiImpl", extends: null, implements: ["LeagueApi"], methods: [], properties: [] }] } as unknown as FileAnalysis;
    expect([...proxiedOnlyTypes([leagueRegistry, caller, server])]).toEqual(["com.acme.api.PersonApi"]);
    expect([...proxiedOnlyTypes([caller])]).toEqual([]);
  });
});
