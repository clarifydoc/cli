import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A value typed on its way into a component or a function: a React parent's `useState` handed down as a prop, an `any` (or
 * untyped) parameter every caller feeds the same class, and a Vue child calling a prop bare from its template. Invented
 * names; labels written by hand from the sources below. Every case has a namesake decoy: `CarApi.load` beside
 * `ClubApi.load`, a child bound to two different types, a function called with two.
 */
const APIS = `export class ClubApi {
  load() { return fetch("/api/clubs"); }
}
export class CarApi {
  load() { return fetch("/api/cars"); }
}
export function useClubApi() {
  async function load() { return fetch("/api/clubs"); }
  return { load };
}
`;

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { react: "^18.0.0", vue: "^3.4.0" } }),
  "src/apis.ts": APIS,
  "src/ClubPanels.tsx": `export function ClubPanel({ api }: { api: any }) {
  return <button onClick={() => api.load()}>Load</button>;
}
export function ClubProps(props: { api: any }) {
  const reload = () => props.api.load();
  return <button onClick={reload}>Reload</button>;
}
export function FactoryPanel({ api: client }: { api: any }) {
  const run = () => client.load();
  return <button onClick={run}>Run</button>;
}
export function MixedPanel({ api }: { api: any }) {
  const mixed = () => api.load();
  return <button onClick={mixed}>Mixed</button>;
}
export function Shadowed({ api }: { api: any }) {
  const inner = (api: { load(): void }) => api.load();
  return <button onClick={() => inner(api)}>Shadowed</button>;
}
export function MapPanel({ api }: { api: any }) {
  const go = () => api.load();
  return <button onClick={go}>Map</button>;
}
export function SpreadPanel({ api }: { api: any }) {
  const spread = () => api.load();
  return <button onClick={spread}>Spread</button>;
}
export function OptionalPanel({ api }: { api: any }) {
  const optional = () => api.load();
  return <button onClick={optional}>Optional</button>;
}
`,
  "src/ClubPage.tsx": `import { useState } from "react";
import { ClubApi, CarApi, useClubApi } from "./apis";
import { ClubPanel, ClubProps, FactoryPanel, MixedPanel, Shadowed, MapPanel, SpreadPanel, OptionalPanel } from "./ClubPanels";
export function ClubPage(rest: any) {
  const [api] = useState(new ClubApi());
  const [typed] = useState<ClubApi | undefined>();
  const [made] = useState(() => useClubApi());
  const [car] = useState(new CarApi());
  return (
    <div>
      <ClubPanel api={api} />
      <ClubProps api={typed} />
      <FactoryPanel api={made} />
      <MixedPanel api={api} />
      <Shadowed api={car} />
      {[1, 2].map((n) => <MapPanel key={n} api={api} />)}
      <SpreadPanel api={api} />
      <SpreadPanel {...rest} />
      <OptionalPanel api={api} />
      <OptionalPanel />
    </div>
  );
}
`,
  "src/CarPage.tsx": `import { useState } from "react";
import { CarApi } from "./apis";
import { MixedPanel } from "./ClubPanels";
export function CarPage() {
  const [api] = useState<CarApi>(new CarApi());
  return <MixedPanel api={api} />;
}
`,
  // An `any` parameter: every caller hands it a ClubApi.
  "src/refresh.ts": `import { ClubApi, CarApi } from "./apis";
export function refresh(api: any) {
  return api.load();
}
export function reloadUntyped(api) {
  return api.load();
}
export function reloadEither(api: any) {
  return api.load();
}
export function openClubs() {
  const first = new ClubApi();
  const second: ClubApi = new ClubApi();
  refresh(first);
  reloadUntyped(second);
  reloadEither(first);
}
export function openCars() {
  const car = new CarApi();
  reloadEither(car);
}
// One call passes a result nothing types, one hands the function on by name, one has a namesake local elsewhere.
export function reloadResult(api: any) {
  return api.load();
}
export function reloadHandedOn(api: any) {
  return api.load();
}
export function reloadScoped(api: any) {
  return api.load();
}
declare function makeApi(): unknown;
export function mixedCalls() {
  const first = new ClubApi();
  reloadResult(first);
  reloadResult(makeApi());
  reloadHandedOn(first);
  [first].forEach(reloadHandedOn);
}
export function typedElsewhere() {
  const shared = new ClubApi();
  return shared;
}
export function untypedHere() {
  const shared = makeApi();
  reloadScoped(shared);
}
`,
  "src/refreshUser.ts": `import { ClubApi } from "./apis";
import { refresh } from "./refresh";
export function again() {
  const api = new ClubApi();
  refresh(api);
}
`,
  // A Vue child calling its prop bare from the template.
  "src/ClubDesk.vue": `<script setup lang="ts">
const props = defineProps<{ api: any; title: string }>();
</script>
<template><button @click="api.load()">{{ title }}</button></template>
`,
  "src/PartDesk.vue": `<script setup lang="ts">
defineProps<{ api: any }>();
</script>
<template><button @click="api.load()">Parts</button></template>
`,
  "src/ClubDeskPage.vue": `<script setup lang="ts">
import ClubDesk from "./ClubDesk.vue";
import PartDesk from "./PartDesk.vue";
import { useClubApi } from "./apis";
const clubApi = useClubApi();
</script>
<template><ClubDesk :api="clubApi" title="Clubs" /><PartDesk :api="clubApi" /></template>
`,
  "src/PartDeskPage.vue": `<script setup lang="ts">
import PartDesk from "./PartDesk.vue";
import { CarApi } from "./apis";
const carApi = new CarApi();
</script>
<template><PartDesk :api="carApi" /></template>
`,
};

describe("a value typed through a React prop, an any parameter and a bare prop in a template", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-prop-types-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lineOf = (file: string, needle: string) => FILES[file]!.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const from = (file: string, symbol: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && /load/.test(l.callName))
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}@${l.targetLine}`);
  const clubClass = `src/apis.ts::ClubApi.load@${lineOf("src/apis.ts", "load() { return fetch(\"/api/clubs\")")}`;
  const clubFactory = `src/apis.ts::load@${lineOf("src/apis.ts", "async function load")}`;

  it("types a destructured React prop from a useState holding a constructed class", () => {
    expect(from("src/ClubPanels.tsx", "ClubPanel")).toEqual([`api.load -> ${clubClass}`]);
  });

  it("types props.<name> from a useState's type argument, and a renamed destructured prop from a factory in an initializer", () => {
    expect(from("src/ClubPanels.tsx", "reload")).toEqual([`props.api.load -> ${clubClass}`]);
    expect(from("src/ClubPanels.tsx", "run")).toEqual([`client.load -> ${clubFactory}`]);
  });

  it("leaves a React prop untyped when two parents bind different types", () => {
    expect(from("src/ClubPanels.tsx", "mixed")).toEqual([]);
  });

  it("does not type a call whose receiver is the callee's own parameter of that name", () => {
    expect(from("src/ClubPanels.tsx", "inner")).toEqual([]);
  });

  it("types an any or untyped parameter from what every caller passes", () => {
    expect(from("src/refresh.ts", "refresh")).toEqual([`api.load -> ${clubClass}`]);
    expect(from("src/refresh.ts", "reloadUntyped")).toEqual([`api.load -> ${clubClass}`]);
  });

  it("leaves a parameter untyped when callers pass different classes", () => {
    expect(from("src/refresh.ts", "reloadEither")).toEqual([]);
  });

  it("leaves a parameter untyped when a call passes something no fact types, the function is handed on, or the local is another function's", () => {
    expect(from("src/refresh.ts", "reloadResult")).toEqual([]);
    expect(from("src/refresh.ts", "reloadHandedOn")).toEqual([]);
    expect(from("src/refresh.ts", "reloadScoped")).toEqual([]);
  });

  it("types a prop of a tag inside a callback from the component's useState", () => {
    expect(from("src/ClubPanels.tsx", "go")).toEqual([`api.load -> ${clubClass}`]);
  });

  it("leaves a React prop untyped when another tag spreads props or leaves it out", () => {
    expect(from("src/ClubPanels.tsx", "spread")).toEqual([]);
    expect(from("src/ClubPanels.tsx", "optional")).toEqual([]);
  });

  it("types a prop called bare in a Vue template from the value every parent binds", () => {
    expect(from("src/ClubDesk.vue", "<setup>")).toEqual([`api.load -> ${clubFactory}`]);
    // Bound to a factory by one parent and a class by another.
    expect(from("src/PartDesk.vue", "<setup>")).toEqual([]);
  });
});
