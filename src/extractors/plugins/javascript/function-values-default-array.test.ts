import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Two JS/React shapes a function value takes on its way down: a default-exported dispatch map handed to a child as a
 * prop, and an array-pattern parameter (`{ pair: [first, second] }`) taking the array a parent hands in. Each project
 * has a namesake decoy (`src/decoy.js`) that must stay unlinked. Labels written by hand.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "garage-probe", dependencies: { react: "^18.2.0", axios: "^1.6.0", "@tanstack/react-table": "^8.0.0" } }),
  "src/decoy.js": `import axios from 'axios';
export function save() { return axios.post('/api/v2/decoy-save'); }
export function remove() { return axios.delete('/api/v2/decoy-remove'); }
export function first() { return axios.get('/api/v2/decoy-first'); }
export function second() { return axios.get('/api/v2/decoy-second'); }
export function park() { return axios.get('/api/v2/decoy-park'); }
`,
  // 1. A default-exported dispatch map handed down: a named member and a function written in place.
  "src/map/clubActions.js": `import axios from 'axios';
function remove() { return axios.delete('/api/v2/clubs-remove'); }
export default { save: () => axios.post('/api/v2/clubs-save'), remove };
`,
  "src/map/ClubRow.jsx": `export function ClubRow({ actions }) {
  return <div><button onClick={() => actions.save()}>s</button><button onClick={() => actions.remove()}>r</button></div>;
}
export function ClubCard(props) {
  return <button onClick={() => props.actions.save()}>s</button>;
}
`,
  "src/map/ClubPage.jsx": `import actions from './clubActions';
import { ClubRow, ClubCard } from './ClubRow';
export function ClubPage() { return <div><ClubRow actions={actions} /><ClubCard actions={actions} /></div>; }
`,
  // The map's own top-level function of the key's name is another function: the key written in place is not it.
  "src/map/garageActions.js": `import axios from 'axios';
function park() { return axios.post('/api/v2/shadow-park'); }
export default { park: () => axios.post('/api/v2/garage-park'), park2: park };
export { park };
`,
  "src/map/GarageRow.jsx": `export function GarageRow({ actions }) {
  return <button onClick={() => actions.park()}>p</button>;
}
`,
  "src/map/GaragePage.jsx": `import actions from './garageActions';
import { GarageRow } from './GarageRow';
export function GaragePage() { return <GarageRow actions={actions} />; }
`,
  // A default export that is no map (a config of data and a component's options) holds no function.
  "src/map/config.js": `export default { name: 'league', limit: 20, tags: ['a'] };
`,
  "src/map/ConfigRow.jsx": `export function ConfigRow({ config }) {
  return <button onClick={() => config.save()}>c</button>;
}
`,
  "src/map/ConfigPage.jsx": `import config from './config';
import { ConfigRow } from './ConfigRow';
export function ConfigPage() { return <ConfigRow config={config} />; }
`,
  // 2. An array-pattern parameter takes the array the parent hands in, position by position.
  "src/pair/Row.jsx": `export function Row({ pair: [first, second] }) {
  return <div><button onClick={() => first()}>a</button><button onClick={() => second()}>b</button></div>;
}
export function Skip({ pair: [, second] }) {
  return <button onClick={() => second()}>b</button>;
}
export function Whole({ pair }) {
  return <button onClick={() => pair[0]()}>w</button>;
}
`,
  "src/pair/Page.jsx": `import axios from 'axios';
import { Row, Skip, Whole } from './Row';
function archive() { return axios.post('/api/v2/clubs-archive'); }
function purge() { return axios.post('/api/v2/clubs-purge'); }
export function Page() {
  return <div><Row pair={[archive, purge]} /><Skip pair={[archive, () => purge()]} /><Whole pair={[archive, purge]} /></div>;
}
`,
  "src/pair/Pager.tsx": `import type { Table } from '@tanstack/react-table';
export function Pager({ pair: [table, setPage] }: { pair: [Table<any>, (n: number) => void] }) {
  return <div><button onClick={() => table.nextPage()}>n</button><button onClick={() => setPage(2)}>s</button></div>;
}
`,
  "src/pair/SquadPage.tsx": `import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import axios from 'axios';
import { Pager } from './Pager';
function loadSquad(n: number) { return axios.get('/api/v2/squads?page=' + n); }
function loadPage() { return axios.get('/api/v2/squads-page'); }
export function SquadPage() {
  const squad = useReactTable({ data: [], columns: [], getCoreRowModel: getCoreRowModel(), onPaginationChange: loadPage });
  return <Pager pair={[squad, loadSquad]} />;
}
`,
};

describe("function values: a default-exported map and an array-pattern parameter", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-fn-default-"));
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

  const from = (file: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === file && l.relation === "dispatch")
      .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}`)
      .sort();

  it("a default-exported map handed down reaches its named and in-place members", () => {
    expect(from("src/map/ClubRow.jsx")).toEqual([
      "ClubCard -props.actions.save-> src/map/clubActions.js:save",
      "ClubRow -actions.remove-> src/map/clubActions.js:remove",
      "ClubRow -actions.save-> src/map/clubActions.js:save",
    ]);
  });
  it("a key written in place does not take a top-level function of the same name", () => {
    expect(from("src/map/GarageRow.jsx")).toEqual([]);
  });
  it("a default export holding no function links nothing", () => {
    expect(from("src/map/ConfigRow.jsx")).toEqual([]);
  });
  it("an array pattern's names are the elements at their positions", () => {
    expect(from("src/pair/Row.jsx").filter((s) => s.startsWith("Row "))).toEqual(["Row -first-> src/pair/Page.jsx:archive", "Row -second-> src/pair/Page.jsx:purge"]);
  });
  it("a hole keeps the positions: the second element is the second", () => {
    const skip = from("src/pair/Row.jsx").filter((s) => s.startsWith("Skip"));
    expect(skip).toHaveLength(1);
    expect(skip[0]).toMatch(/^Skip -second-> src\/pair\/Page\.jsx:/);
    expect(skip[0]).not.toContain(":archive");
  });
  it("an array a component takes whole is no array pattern", () => {
    expect(from("src/pair/Row.jsx").filter((s) => s.startsWith("Whole"))).toEqual([]);
  });
  it("an array pattern reads a library object and a function handed in the same array", () => {
    expect(from("src/pair/Pager.tsx")).toEqual(["Pager -setPage-> src/pair/SquadPage.tsx:loadSquad", "Pager -table.nextPage-> src/pair/SquadPage.tsx:loadPage"]);
  });
  it("no decoy is ever linked", () => {
    expect(summary.symbolLinks.filter((l) => l.targetFile === "src/decoy.js")).toEqual([]);
  });
});
