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
export function send() { return axios.delete('/api/v2/decoy-send'); }
export function filter() { return axios.delete('/api/v2/decoy-filter'); }
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
  // 7. A context read into a local, a member of it called.
  "src/ctx/alias.tsx": `import { createContext, useContext } from 'react';
import axios from 'axios';
export interface Moves { onSell: () => void }
function sell() { axios.post('/api/v2/sell-alias'); }
export const MoveContext = createContext<Moves>({ onSell: sell });
export function SellButton() { const ctx = useContext(MoveContext); return <button onClick={() => ctx.onSell()}>S</button>; }
`,
  // 8. A JSX array of arrows written in place under a prop.
  "src/r/ActionList.jsx": `export function ActionList({ actions }) {
  return <div>{actions.map((a) => <button key={a.label} onClick={() => a.run()}>{a.label}</button>)}</div>;
}
`,
  "src/r/ListPage.jsx": `import axios from 'axios';
import { ActionList } from './ActionList';
function award() { axios.post('/api/v2/awards-list'); }
export function ListPage() {
  return <ActionList actions={[{ label: 'Award', run: () => award() }, { label: 'Cup', run: () => axios.post('/api/v2/cups-list') }]} />;
}
`,
  // 9. A computed key below the first level.
  "src/r/deep.js": `import axios from 'axios';
export function runDeep(kind) {
  const archive = () => axios.post('/api/v2/deep-archive');
  const purge = () => axios.post('/api/v2/deep-purge');
  const kits = { club: { x: { run: archive }, y: { run: purge } } };
  kits.club[kind].run();
}
`,
  // 10. A rest binding of the props pattern: `others.order()` is the prop `order`.
  "src/rest/Row.jsx": `export function Row({ n, ...others }) {
  return <button onClick={() => others.order(n)}>go</button>;
}
`,
  "src/rest/RowPage.jsx": `import axios from 'axios';
import { Row } from './Row';
function orderKit(size) { axios.post('/api/v2/order-kit-rest'); }
export function RowPage() { return <Row n={1} order={orderKit} />; }
`,
  // 11. A handler under a noise-named key (`send`, `filter`) written in place.
  "src/n/league.js": `import axios from 'axios';
const actions = { send: () => axios.post('/api/v2/league-send'), filter: () => axios.get('/api/v2/league-filter') };
export function runLeague() { actions.send(); actions.filter(); }
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
  // A module object's member is no call on a name a parameter or a nearer declaration rebinds.
  "src/n/shadow.js": `const cache = { get: () => 1, send: () => 2 };
export function run(cache) { cache.get("a"); cache.send("b"); }
export function run2() { const cache = new Map(); cache.get("a"); }
export function run3() { cache.get("a"); }
`,
  // A function's own local object is the owner of its member, beside a module-level namesake object.
  "src/n/local-owner.js": `const actions = { get: () => 1 };
function load() { return 2; }
export const useClubSelf = function () {
  const actions = { get() { return load(); }, async rename() { return 3; } };
  const club = actions.get();
  actions.rename();
  actions.other();
  return { actions, club };
};
export function outer() { return actions.get(); }
`,
  // A context alias holds inside the function that read it.
  "src/ctx/scoped.tsx": `import { createContext, useContext } from 'react';
import axios from 'axios';
function drain() { axios.post('/api/v2/drain-scoped'); }
export const Cmd = createContext({ onPurge: drain });
export function a() { const ctx = useContext(Cmd); return ctx; }
export function b(ctx) { ctx.onPurge(); }
export function c(rows) { const ctx = useContext(Cmd); rows.forEach((ctx) => ctx.onPurge()); return ctx; }
export function d() { const ctx = useContext(Cmd); return () => ctx.onPurge(); }
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
  it("7 a context read into a local, a member called", () => {
    expect(from("src/ctx/alias.tsx")).toEqual(["SellButton -ctx.onSell-> src/ctx/alias.tsx:sell"]);
  });
  it("8 a JSX array of arrows written in place under a prop", () => {
    expect(from("src/r/ActionList.jsx")).toEqual(["ActionList -a.run-> src/r/ListPage.jsx:<ActionList:actions[].run@5#2>", "ActionList -a.run-> src/r/ListPage.jsx:<ActionList:actions[].run@5>"]);
    // The arrow that hands on a declared function reaches it through its own call.
    const onward = summary.symbolLinks.filter((l) => l.sourceFile === "src/r/ListPage.jsx" && l.callName === "award").map((l) => `${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`);
    expect(onward).toEqual(["<ActionList:actions[].run@5> -> src/r/ListPage.jsx:award"]);
  });
  it("9 a computed key below the first level", () => {
    expect(from("src/r/deep.js")).toEqual(["runDeep -kits.club[].run-> src/r/deep.js:archive", "runDeep -kits.club[].run-> src/r/deep.js:purge"]);
  });
  it("10 a rest binding of the props pattern", () => {
    expect(from("src/rest/Row.jsx")).toEqual(["Row -others.order-> src/rest/RowPage.jsx:orderKit"]);
  });
  it("11 a handler under a noise-named key written in place", () => {
    const calls = summary.symbolLinks.filter((l) => l.sourceFile === "src/n/league.js").map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}`).sort();
    expect(calls).toEqual(["runLeague -actions.filter-> src/n/league.js:actions.filter", "runLeague -actions.send-> src/n/league.js:actions.send"]);
  });
  it("a module object's own member keeps its link when another object has a member of that name", () => {
    const one = summary.symbolLinks.filter((l) => l.callName === "clubKeys.one").map((l) => `${l.sourceFile}:${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`).sort();
    expect(one).toEqual(["src/keys/admin.ts:refreshClub -> src/keys/clubs.ts:clubKeys.one", "src/keys/clubs.ts:clubQuery -> src/keys/clubs.ts:clubKeys.one"]);
  });
  it("a rebound name is no call on the module object's inline member", () => {
    const calls = summary.symbolLinks.filter((l) => l.sourceFile === "src/n/shadow.js").map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}`).sort();
    expect(calls).toEqual(["run3 -cache.get-> src/n/shadow.js:cache.get"]);
  });
  it("a local object literal holding the key owns the call; a literal without it is a rebinding", () => {
    const calls = summary.symbolLinks.filter((l) => l.sourceFile === "src/n/local-owner.js").map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}:${l.targetLine ?? ""}`).sort();
    // The local object's `get` (line 4) for the call inside the function, the module object's (line 1) for the one outside;
    // `other` is no key of the local literal, so it links nowhere.
    expect(calls.filter((c) => c.includes("-actions."))).toEqual([
      "outer -actions.get-> src/n/local-owner.js:actions.get:1",
      "useClubSelf -actions.get-> src/n/local-owner.js:actions.get:4",
      "useClubSelf -actions.rename-> src/n/local-owner.js:actions.rename:4",
    ]);
  });
  it("a context alias of one function is no alias of another function's parameter", () => {
    const calls = summary.symbolLinks.filter((l) => l.sourceFile === "src/ctx/scoped.tsx").map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}`).sort();
    // Only the closure over the function's own alias runs the context's member.
    expect(calls).toEqual(["d -ctx.onPurge-> src/ctx/scoped.tsx:drain"]);
  });
  it("no decoy is ever linked", () => {
    expect(summary.symbolLinks.filter((l) => l.targetFile === "src/decoy.js")).toEqual([]);
  });
});
