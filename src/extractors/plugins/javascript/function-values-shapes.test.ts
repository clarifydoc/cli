import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Four more shapes a function value takes on its way to the call that runs it: a mixin that takes on a mixin, a kit
 * registered from an array by each component's own `name`, an array of action objects a parent hands down as a prop
 * (the child loops over it), and an arrow written under a prop no `on…` name marks that calls no function the file
 * declares. Each has a namesake decoy that must stay unlinked. Labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-probe", dependencies: { vue: "^2.7.0", react: "^18.2.0", axios: "^1.6.0" } }),
  // A mixin of a mixin.
  "src/mixins/baseActions.js": `import axios from 'axios';
export default {
  methods: {
    async saveStadium() { await axios.put('/api/v2/stadiums/1'); },
  },
};
`,
  "src/mixins/adminActions.js": `import baseActions from './baseActions';
export default {
  mixins: [baseActions],
  methods: { audit() { return 1; } },
};
`,
  "src/decoy/other.js": `import axios from 'axios';
export function saveStadium() { return axios.delete('/api/v2/decoy'); }
`,
  "src/components/StadiumForm.vue": `<script>
export default {
  props: { onSave: { type: Function, required: true } },
  methods: { submit() { this.onSave(); } },
};
</script>
<template><button @click="submit">Save</button></template>
`,
  "src/pages/StadiumPage.vue": `<script>
import StadiumForm from '../components/StadiumForm.vue';
import adminActions from '../mixins/adminActions';
export default { components: { StadiumForm }, mixins: [adminActions] };
</script>
<template><StadiumForm :on-save="saveStadium" /></template>
`,
  // A kit registered from an array by name.
  "src/components/ClubBadge.vue": `<script>
export default { name: 'ClubBadge', methods: { press() { this.$emit('press'); } } };
</script>
<template><button @click="press">Badge</button></template>
`,
  "src/components/ClubFlag.vue": `<script>
export default { name: 'ClubFlag', methods: { press() { this.$emit('press'); } } };
</script>
<template><button @click="press">Flag</button></template>
`,
  "src/components/index.js": `import ClubBadge from './ClubBadge.vue';
const components = [ClubBadge];
export default { install(Vue) { components.forEach((c) => Vue.component(c.name, c)); } };
`,
  "src/main.js": `import Vue from 'vue';
import Kit from './components';
Vue.use(Kit);
`,
  "src/pages/BadgePage.vue": `<script>
import axios from 'axios';
export default { methods: { award() { axios.post('/api/v2/badges'); }, flag() { axios.post('/api/v2/flags'); } } };
</script>
<template><div><club-badge @press="award" /><ClubFlag @press="flag" /></div></template>
`,
  // An array handed down as a prop.
  "src/components/Toolbar.vue": `<script>
export default { props: { extra: { type: Array, default: () => [] } } };
</script>
<template><div><button v-for="x in extra" :key="x.label" @click="x.run()">{{ x.label }}</button></div></template>
`,
  "src/pages/ToolbarPage.vue": `<script>
import Toolbar from '../components/Toolbar.vue';
import axios from 'axios';
export default { components: { Toolbar }, methods: { archive() { axios.post('/api/v2/archive'); }, purge() { axios.post('/api/v2/purge'); } } };
</script>
<template><Toolbar :extra="[{ label: 'Archive', run: archive }]" /></template>
`,
  // A non-`on` prop's arrow.
  "src/r/Closer.jsx": `export function Closer({ handleClose }) { return <button onClick={() => handleClose()}>Close</button>; }
`,
  "src/r/Page.jsx": `import axios from 'axios';
import { useState } from 'react';
import { Closer } from './Closer';
export function Page() {
  const [open, setOpen] = useState(true);
  const reload = () => axios.get('/api/v2/reload');
  return (
    <div>
      <Closer handleClose={() => setOpen(false)} />
      <Closer handleClose={() => reload()} />
    </div>
  );
}
`,
};

describe("function values: mixin of a mixin, kit by name, array props, arrow under a plain prop", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-fn-values-"));
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

  const dispatchFrom = (file: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === file && l.relation === "dispatch")
      .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}`)
      .sort();

  it("finds a method the page's mixin takes from its own mixin, never the namesake function elsewhere", () => {
    expect(dispatchFrom("src/components/StadiumForm.vue")).toEqual(["submit -this.onSave-> src/mixins/baseActions.js:saveStadium"]);
  });

  it("registers a kit's array under each component's own name; a component outside the array stays unregistered", () => {
    expect(dispatchFrom("src/components/ClubBadge.vue")).toEqual(["press -emit:press-> src/pages/BadgePage.vue:award"]);
    expect(dispatchFrom("src/components/ClubFlag.vue")).toEqual([]);
  });

  it("carries the functions of an array literal a parent hands down to the child's loop over that prop", () => {
    expect(dispatchFrom("src/components/Toolbar.vue")).toEqual(["<template> -run-> src/pages/ToolbarPage.vue:archive"]);
  });

  it("gives an arrow under a non-`on` prop its own function when it hands on no declared one, and keeps the handoff when it does", () => {
    expect(dispatchFrom("src/r/Closer.jsx")).toEqual(["Closer -handleClose-> src/r/Page.jsx:<Closer:handleClose@9>", "Closer -handleClose-> src/r/Page.jsx:reload"]);
  });
});
