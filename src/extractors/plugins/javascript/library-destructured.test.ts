import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseSource } from "../../../parsers/parser-manager.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { objectTypesOf, patternPaths } from "./destructured-params.js";

/**
 * A library result destructured into bare names (`const { mutate } = useMutation({ mutationFn })`) runs the
 * `mutationFn` written at the hook call, like `m.mutate()` does; and a destructured parameter's type that extends
 * another, is declared in another file or sits in a nested pattern types the bindings it names.
 * Decoys: a namesake `mutate` of a project hook, a parameter or inner declaration named `mutate`, another component's
 * mutation function, a state flag, a namesake class beside the one the annotation names.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { react: "^18.3.0", "@tanstack/react-query": "^5.0.0" } }),
  "src/api.ts": `export function saveClub(club: string) { return fetch("/api/clubs", { method: "POST", body: club }); }
export function releasePlayer(id: string) { return fetch("/api/players/release", { method: "POST", body: id }); }
export function saveGarage(car: string) { return fetch("/api/garages", { method: "POST", body: car }); }
`,
  "src/local.ts": `export function useMutation(options: { mutationFn: (x: string) => unknown }) {
  return { mutate: (x: string) => x };
}
`,
  "src/ClubForm.tsx": `import { useMutation } from "@tanstack/react-query";
import { saveClub, releasePlayer } from "./api";
export function ClubForm() {
  const { mutate, isPending } = useMutation({ mutationFn: saveClub });
  const { mutateAsync: release } = useMutation({ mutationFn: (id: string) => releasePlayer(id) });
  return <button disabled={isPending} onClick={() => { mutate("a"); release("b"); }}>save</button>;
}
`,
  "src/GarageForm.tsx": `import { useMutation } from "@tanstack/react-query";
import { saveGarage } from "./api";
export function GarageForm() {
  const { mutate } = useMutation({ mutationFn: saveGarage });
  return <button onClick={() => mutate("c")}>save</button>;
}
`,
  "src/Local.tsx": `import { useMutation } from "./local";
import { saveGarage } from "./api";
export function Local() {
  const { mutate } = useMutation({ mutationFn: saveGarage });
  return <button onClick={() => mutate("d")}>save</button>;
}
`,
  "src/Shadow.tsx": `import { useMutation } from "@tanstack/react-query";
import { saveClub } from "./api";
export function Shadow() {
  const { mutate } = useMutation({ mutationFn: saveClub });
  const run = (mutate: (x: string) => void) => mutate("e");
  return <button onClick={() => run(() => {})}>save</button>;
}
`,
  // Two components of one file each hold their own `mutate`; a state method no option runs keeps its name.
  "src/Two.tsx": `import { useMutation, useQuery } from "@tanstack/react-query";
import { saveClub, saveGarage } from "./api";
export function ClubSide() {
  const { mutate } = useMutation({ mutationFn: saveClub });
  const { refetch } = useQuery({ queryKey: ["a"], queryFn: () => saveGarage("x") });
  refetch();
  return <button onClick={() => mutate("f")}>save</button>;
}
export function GarageSide() {
  const { mutate } = useMutation({ mutationFn: saveGarage });
  for (const mutate of []) mutate("g");
  return <button onClick={() => mutate("h")}>save</button>;
}
`,
  "src/types.ts": `export interface Props { store: ClubStore }
export class ClubStore { load() { return fetch("/api/clubs"); } }
`,
  "src/garage.ts": `export class GarageStore { load() { return fetch("/api/garages"); } }
`,
  "src/Params.tsx": `import type { Props } from "./types";
interface Base { store: LocalStore }
interface Mine extends Base { n: number }
type Both = Base & { n: number };
class LocalStore { load() { return fetch("/api/local"); } }
export function Extended({ store }: Mine) { store.load(); }
export function Intersected({ store }: Both) { store.load(); }
export function Imported({ store }: Props) { store.load(); }
export function Nested({ a: { store } }: { a: { store: LocalStore } }) { store.load(); }
export function Untyped({ store }: { n: number }) { store.load(); }
`,
};

const linksFrom = (s: ProjectAnalysis, file: string): string[] =>
  (s.symbolLinks ?? [])
    .filter((l) => l.sourceFile === file && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`);

describe("library results and destructured parameters", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-library-destructured-"));
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

  it("runs the mutationFn from a destructured mutate and a renamed mutateAsync", () => {
    const rows = linksFrom(summary, "src/ClubForm.tsx").filter((r) => r.includes("dispatch") || r.includes("mutate") || r.includes("release"));
    expect(rows.some((r) => r.includes("src/api.ts#saveClub") && r.includes("-mutate."))).toBe(true);
    expect(rows.some((r) => r.includes("-release.mutateAsync->"))).toBe(true);
    expect(linksFrom(summary, "src/ClubForm.tsx").some((r) => r.includes("saveGarage"))).toBe(false);
  });

  it("keeps each component's own mutation function", () => {
    expect(linksFrom(summary, "src/GarageForm.tsx").filter((r) => r.includes("-mutate."))).toEqual(["GarageForm -mutate.mutate-> src/api.ts#saveGarage"]);
  });

  it("keeps the holders of two components in one file apart", () => {
    const rows = linksFrom(summary, "src/Two.tsx").filter((r) => r.includes("-mutate."));
    expect(rows).toContain("ClubSide -mutate.mutate-> src/api.ts#saveClub");
    expect(rows).toContain("GarageSide -mutate.mutate-> src/api.ts#saveGarage");
    expect(rows.filter((r) => r.startsWith("ClubSide") && r.includes("saveGarage"))).toEqual([]);
    expect(rows.filter((r) => r.startsWith("GarageSide") && r.includes("saveClub"))).toEqual([]);
    // `refetch` runs the query's own `queryFn` (TanStack Query), held for ClubSide's query alone.
    const refetches = linksFrom(summary, "src/Two.tsx").filter((r) => r.includes("refetch.refetch"));
    expect(refetches).toEqual(["ClubSide -refetch.refetch-> src/Two.tsx#<useQuery:queryFn@5>"]);
  });

  it("never reads a project hook's mutate as the library's", () => {
    expect(linksFrom(summary, "src/Local.tsx").filter((r) => r.includes(".mutate->"))).toEqual([]);
  });

  it("leaves a name a nearer parameter binds alone", () => {
    expect(linksFrom(summary, "src/Shadow.tsx").filter((r) => r.includes("mutate.mutate"))).toEqual([]);
  });

  it("types a binding through a same-file extends, an intersection, an import and a nested pattern", () => {
    const rows = linksFrom(summary, "src/Params.tsx").filter((r) => r.includes("store.load"));
    expect(rows).toContain("Extended -store.load-> src/Params.tsx#LocalStore.load");
    expect(rows).toContain("Intersected -store.load-> src/Params.tsx#LocalStore.load");
    expect(rows).toContain("Imported -store.load-> src/types.ts#ClubStore.load");
    expect(rows).toContain("Nested -store.load-> src/Params.tsx#LocalStore.load");
    expect(rows.filter((r) => r.startsWith("Untyped"))).toEqual([]);
    expect(rows.some((r) => r.includes("garage.ts"))).toBe(false);
  });

  it("reads nested patterns and the members a type takes from its same-file bases", async () => {
    expect(patternPaths("{ a, b: c, d: { e, f: g = 1 }, ...rest }")).toEqual([
      { binding: "a", path: ["a"] },
      { binding: "c", path: ["b"] },
      { binding: "e", path: ["d", "e"] },
      { binding: "g", path: ["d", "f"] },
    ]);
    const tree = await parseSource("interface A { x: X } interface B extends A, C { y: Y } interface C { z: Z } interface Loop extends Loop { w: W }", "typescript");
    const types = objectTypesOf(tree.rootNode);
    expect([...types.get("B")!.keys()].sort()).toEqual(["x", "y", "z"]);
    expect([...types.get("Loop")!.keys()]).toEqual(["w"]);
  });
});
