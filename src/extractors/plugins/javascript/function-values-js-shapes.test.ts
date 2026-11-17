import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Six more JS shapes a function value takes on its way to the call that runs it. Each project has a namesake decoy
 * (`src/decoy.js` declares `archive`/`purge`/`reload`/`award`) that must stay unlinked. Labels written by hand.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "garage-probe", dependencies: { vue: "^3.4.0", react: "^18.2.0", axios: "^1.6.0" } }),
  "src/decoy.js": `import axios from 'axios';
export function archive() { return axios.delete('/api/v2/decoy-archive'); }
export function purge() { return axios.delete('/api/v2/decoy-purge'); }
export function reload() { return axios.delete('/api/v2/decoy-reload'); }
export function award() { return axios.delete('/api/v2/decoy-award'); }
`,
  // 1. A Vue template arrow under a non-`on` prop.
  "src/vue/Closer.vue": `<script>
export default { props: { handleClose: { type: Function, required: true } }, methods: { close() { this.handleClose(); } } };
</script>
<template><button @click="close">Close</button></template>
`,
  "src/vue/ClosePage.vue": `<script>
import Closer from './Closer.vue';
import axios from 'axios';
export default { components: { Closer }, methods: { archive() { axios.post('/api/v2/archive'); } } };
</script>
<template><Closer :handle-close="() => archive()" /></template>
`,
  // 2. Spread elements in a kit array.
  "src/vue/Toolbar.vue": `<script>
export default { props: { extra: { type: Array, default: () => [] } } };
</script>
<template><div><button v-for="x in extra" :key="x.label" @click="x.run()">{{ x.label }}</button></div></template>
`,
  "src/vue/ToolbarPage.vue": `<script>
import Toolbar from './Toolbar.vue';
import axios from 'axios';
const base = [{ label: 'Archive', run: archive }];
function archive() { axios.post('/api/v2/archive-kit'); }
function purge() { axios.post('/api/v2/purge-kit'); }
const kit = [...base, { label: 'Purge', run: purge }];
export default { components: { Toolbar }, data() { return { kit }; } };
</script>
<template><Toolbar :extra="kit" /></template>
`,
  // 3. A React .map over a prop array.
  "src/r/ActionBar.jsx": `export function ActionBar({ actions }) {
  return <div>{actions.map((a) => <button key={a.label} onClick={() => a.run()}>{a.label}</button>)}</div>;
}
`,
  "src/r/BarPage.jsx": `import axios from 'axios';
import { ActionBar } from './ActionBar';
export function BarPage() {
  const award = () => axios.post('/api/v2/awards');
  return <ActionBar actions={[{ label: 'Award', run: award }]} />;
}
`,
  // 4. this-rooted nested call and a computed member call.
  "src/r/Panel.jsx": `import React from 'react';
export class Panel extends React.Component {
  render() { return <button onClick={() => this.props.action.onClick()}>Go</button>; }
}
export function Keyed({ handlers, kind }) {
  return <button onClick={() => handlers[kind].run()}>Go</button>;
}
`,
  "src/r/PanelPage.jsx": `import axios from 'axios';
import { Panel, Keyed } from './Panel';
export function PanelPage() {
  const reload = () => axios.get('/api/v2/reload-panel');
  return <div><Panel action={{ onClick: reload }} /></div>;
}
`,
  // 4b. A computed key picks the member.
  "src/r/kits.js": `import axios from 'axios';
export function runKit(kind) {
  const archive = () => axios.post('/api/v2/archive-kit-key');
  const purge = () => axios.post('/api/v2/purge-kit-key');
  const kit = { club: { run: archive }, car: { run: purge } };
  kit[kind].run();
}
`,
  // 5. Module-level reactive<T> and createContext<T> literals.
  "src/ctx/store.ts": `import { reactive, createContext } from 'vue';
import axios from 'axios';
export interface Actions { onSave: () => void }
function archive() { axios.post('/api/v2/archive-ctx'); }
export const state = reactive<Actions>({ onSave: archive });
`,
  "src/ctx/Saver.ts": `import { state } from './store';
export function press() { state.onSave(); }
`,
  "src/ctx/context.tsx": `import { createContext, useContext } from 'react';
import axios from 'axios';
export interface Cmds { onPurge: () => void }
function purge() { axios.post('/api/v2/purge-ctx'); }
export const CmdContext = createContext<Cmds>({ onPurge: purge });
export function PurgeButton() { const { onPurge } = useContext(CmdContext); return <button onClick={() => onPurge()}>P</button>; }
`,
  // 6. Destructuring in a parameter list read as a copy.
  "src/d/Btn.tsx": `interface Props { onClick: () => void }
export function Btn({ onClick }: Props) {
  const fire = () => onClick();
  return <button onClick={fire}>x</button>;
}
`,
  "src/d/BtnPage.tsx": `import axios from 'axios';
import { Btn } from './Btn';
export function BtnPage() {
  const archive = () => axios.post('/api/v2/archive-btn');
  return <Btn onClick={archive} />;
}
`,
  // A module-level object whose member is written in place, called in its own file and from another; some other
  // object of the project holds a member of the same name (real-repo FP: the call lost its link to the member).
  "src/keys/clubs.ts": `export const clubKeys = {
  all: ['clubs'] as const,
  one: (id: number, kind: string = 'club') => ['clubs', id, kind] as const,
}
export function clubQuery(id: number) { return { queryKey: clubKeys.one(id, 'club') } }
`,
  "src/keys/admin.ts": `import { clubKeys } from './clubs'
export function refreshClub(id: number) { return clubKeys.one(id, 'cup') }
`,
  "src/keys/kit.ts": `function cup() { return 'cup' }
const kit = { one: cup }
export function runKit() { kit.one() }
`,
};

describe("function values: six JS shapes", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-fn-js-"));
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
      .filter((l) => l.sourceFile === file && (l.relation === "dispatch" || l.strategy === "value-flow"))
      .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}`)
      .sort();

  it("1 vue template arrow under a plain prop", () => {
    expect(from("src/vue/Closer.vue")).toEqual([expect.stringContaining("src/vue/ClosePage.vue")]);
  });
  it("2 spread in a kit array", () => {
    expect(from("src/vue/Toolbar.vue")).toEqual(["<template> -run-> src/vue/ToolbarPage.vue:archive", "<template> -run-> src/vue/ToolbarPage.vue:purge"]);
  });
  it("3 react map over a prop array", () => {
    expect(from("src/r/ActionBar.jsx")).toEqual(["ActionBar -a.run-> src/r/BarPage.jsx:award"]);
  });
  it("4a this.props.action.onClick", () => {
    expect(from("src/r/Panel.jsx").filter((s) => s.includes("onClick"))).toEqual(["Panel.render -this.props.action.onClick-> src/r/PanelPage.jsx:reload"]);
  });
  it("4b a computed key reads every member", () => {
    expect(from("src/r/kits.js")).toEqual(["runKit -kit[].run-> src/r/kits.js:<archive@3>".replace("<archive@3>", "archive"), "runKit -kit[].run-> src/r/kits.js:purge"]);
  });
  it("5a reactive<T> literal", () => {
    expect(from("src/ctx/Saver.ts")).toEqual(["press -state.onSave-> src/ctx/store.ts:archive"]);
  });
  it("5b createContext<T> literal", () => {
    expect(from("src/ctx/context.tsx")).toEqual(["PurgeButton -onPurge-> src/ctx/context.tsx:purge"]);
  });
  it("6 destructured parameter copy", () => {
    expect(from("src/d/Btn.tsx")).toEqual(["fire -onClick-> src/d/BtnPage.tsx:archive"]);
  });
  it("a module object's own member keeps its link when another object has a member of that name", () => {
    const one = summary.symbolLinks.filter((l) => l.callName === "clubKeys.one").map((l) => `${l.sourceFile}:${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`).sort();
    expect(one).toEqual(["src/keys/admin.ts:refreshClub -> src/keys/clubs.ts:clubKeys.one", "src/keys/clubs.ts:clubQuery -> src/keys/clubs.ts:clubKeys.one"]);
  });
  it("no decoy is ever linked", () => {
    expect(summary.symbolLinks.filter((l) => l.targetFile === "src/decoy.js")).toEqual([]);
  });
});
