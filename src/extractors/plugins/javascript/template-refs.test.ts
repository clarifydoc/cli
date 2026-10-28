import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { JsTemplateRefResolver, templateRefCall } from "./template-refs.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Each file analyzed as the pipeline does (the SFC preprocess included), then the resolver over all of them. */
async function links(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "template-refs-"));
  const out = await mkdtemp(join(tmpdir(), "template-refs-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: rel.endsWith(".js") ? "javascript" : "typescript" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return new JsTemplateRefResolver().resolve(analyses).map((l) => `${l.sourceSymbol} -[${l.callName}]-> ${l.targetFile}::${l.targetSymbol}`);
}

const CLUB_FORM = `<script setup lang="ts">
import { ref } from 'vue';
const name = ref('');
async function save() { await api.post('/api/v2/clubs', { name: name.value }); }
function reset() { name.value = ''; }
defineExpose({ save, reset });
</script>
<template><input v-model="name" /></template>
`;

const PLAYER_DIALOG = `<script>
export default {
  methods: {
    open(id) { return api.get('/api/v2/players/' + id); },
    close() { this.visible = false; },
  },
};
</script>
<template><div /></template>
`;

describe("template-ref dispatch", () => {
  it("joins a call through a Vue template ref to the child's method — script setup, Options API, markup and useTemplateRef", async () => {
    const out = await links({
      "web/components/ClubForm.vue": CLUB_FORM,
      "web/components/PlayerDialog.vue": PLAYER_DIALOG,
      "web/pages/ClubPage.vue": `<script setup lang="ts">
import { ref, useTemplateRef } from 'vue';
import ClubForm from '../components/ClubForm.vue';
import PlayerDialog from '../components/PlayerDialog.vue';
const formRef = ref(null);
const dialog = useTemplateRef('playerDialog');
function submit() { formRef.value.save(); }
function clear() { formRef.value?.reset(); }
function showPlayer(id: number) { dialog.value?.open(id); }
</script>
<template>
  <ClubForm ref="formRef" />
  <player-dialog ref="playerDialog" />
  <button @click="submit">Save</button>
  <button @click="playerDialog?.close()">Close</button>
</template>
`,
      "web/pages/LeagueList.vue": `<script>
import PlayerDialog from '../components/PlayerDialog.vue';
export default {
  components: { PlayerDialog },
  methods: {
    show(id) { this.$refs.playerDialog.open(id); },
    hide() { this.$refs['playerDialog']?.close(); },
  },
};
</script>
<template>
  <PlayerDialog ref="playerDialog" />
  <button @click="$refs.playerDialog.close()">Close</button>
</template>
`,
    });
    expect(out.sort()).toEqual([
      "<setup> -[$refs.playerDialog.close]-> web/components/PlayerDialog.vue::close",
      "<setup> -[playerDialog.close]-> web/components/PlayerDialog.vue::close",
      "clear -[formRef.value?.reset]-> web/components/ClubForm.vue::reset",
      "hide -[this.$refs['playerDialog']?.close]-> web/components/PlayerDialog.vue::close",
      "show -[this.$refs.playerDialog.open]-> web/components/PlayerDialog.vue::open",
      "showPlayer -[dialog.value?.open]-> web/components/PlayerDialog.vue::open",
      "submit -[formRef.value.save]-> web/components/ClubForm.vue::save",
    ]);
  });

  it("joins React's forwardRef handle, and leaves out a ref two different children carry", async () => {
    const out = await links({
      "web/CarForm.tsx": `import React, { forwardRef, useImperativeHandle } from 'react';
export const CarForm = forwardRef(function CarForm(props: {}, ref) {
  async function save() { await api.post('/api/v2/cars', {}); }
  useImperativeHandle(ref, () => ({ save }));
  return <form />;
});
export default CarForm;
`,
      "web/GaragePage.tsx": `import React, { useRef } from 'react';
import CarForm from './CarForm';
export function GaragePage() {
  const formRef = useRef(null);
  const submit = () => formRef.current?.save();
  return <div><CarForm ref={formRef} /><button onClick={submit}>Save</button></div>;
}
`,
      "web/components/ClubForm.vue": CLUB_FORM,
      "web/components/PlayerDialog.vue": PLAYER_DIALOG,
      "web/pages/Both.vue": `<script setup>
import ClubForm from '../components/ClubForm.vue';
import PlayerDialog from '../components/PlayerDialog.vue';
function go() { panel.value.open(); }
</script>
<template>
  <ClubForm v-if="club" ref="panel" />
  <PlayerDialog v-else ref="panel" />
</template>
`,
    });
    expect(out).toEqual(["submit -[formRef.current?.save]-> web/CarForm.tsx::save"]);
  });

  it("reads a bare `ref.member` as a template ref only in markup, where refs unwrap", () => {
    expect(templateRefCall("formRef.save", true)).toEqual({ ref: "formRef", member: "save" });
    expect(templateRefCall("formRef.save", false)).toBeNull();
    expect(templateRefCall("formRef.value", false)).toBeNull();
    expect(templateRefCall("this.formRef.current.save", false)).toEqual({ ref: "this.formRef", member: "save" });
  });
});
