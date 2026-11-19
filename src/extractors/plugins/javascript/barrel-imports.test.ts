import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { keyOf, usageGate } from "../../../core/symbol-graph.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const handler = (name: string, path: string) => `  const ${name} = async () => { await fetch("/api/${path}/1", { method: "PUT" }); };`;
const reactPage = (name: string, drop: string, imp: string, tag: string) => `${imp}
export function ${name}() {
${handler(drop, drop)}
  return ${tag.replace("DROP", drop)};
}
`;
const vuePage = (drop: string, imp: string, tag: string) => `<script setup lang="ts">
${imp}
async function ${drop}() { await fetch("/api/${drop}/1", { method: "DELETE" }); }
</script>
<template>${tag.replace("DROP", drop)}</template>
`;

const dialog = (prop: string) => `export function Dialog({ ${prop} }: { ${prop}: () => void }) { return <button onClick={() => ${prop}()}>OK</button>; }\n`;

const REACT: Record<string, string> = {
  "package.json": `{"name":"club","dependencies":{"react":"18"}}`,
  "src/ui/ConfirmDialog.tsx": dialog("onConfirm").replace("Dialog", "ConfirmDialog"),
  "src/ui/Whistle.tsx": dialog("onBlow").replace("Dialog", "Whistle"),
  // The same name in another folder, which no barrel export reaches.
  "src/other/ConfirmDialog.tsx": dialog("onConfirm").replace("Dialog", "ConfirmDialog"),
  "src/ui/index.ts": `export { ConfirmDialog } from "./ConfirmDialog";\nexport { Whistle as Referee } from "./Whistle";\n`,
  "src/pages/ClubPage.tsx": reactPage("ClubPage", "dropClub", `import { ConfirmDialog } from "../ui";`, "<ConfirmDialog onConfirm={DROP} />"),
  "src/pages/MatchPage.tsx": reactPage("MatchPage", "dropMatch", `import { ConfirmDialog } from "../ui";`, "<ConfirmDialog onConfirm={DROP} />"),
  "src/pages/ListPage.tsx": `import { ConfirmDialog } from "../ui";\nexport function ListPage() { return <ConfirmDialog />; }\n`,
  // A renamed export under another local name.
  "src/pages/RefPage.tsx": reactPage("RefPage", "blow", `import { Referee as W } from "../ui";`, "<W onBlow={DROP} />"),
  // A name the barrel does not export.
  "src/pages/GaragePage.tsx": reactPage("GaragePage", "dropGarage", `import { ConfirmDialog } from "../other";`, "<ConfirmDialog onConfirm={DROP} />"),
  // Nested namespaces, a namespace re-exported by `export * as`, a CommonJS namespace.
  "src/kit/forms/Dialog.tsx": dialog("onSave"),
  "src/kit/forms/index.ts": `export { Dialog } from "./Dialog";\n`,
  "src/kit/dup1/index.tsx": dialog("onSave").replace("Dialog", "Twin"),
  "src/kit/dup2/index.tsx": dialog("onSave").replace("Dialog", "Twin"),
  "src/kit/index.ts": `export * as Forms from "./forms";\nexport * from "./dup1";\nexport * from "./dup2";\n`,
  "src/lib.ts": `export * as Kit from "./kit";\n`,
  "src/pages/NestPage.tsx": reactPage("NestPage", "saveNest", `import * as Kit from "../kit";`, "<Kit.Forms.Dialog onSave={DROP} />"),
  "src/pages/NamedNsPage.tsx": reactPage("NamedNsPage", "saveNamed", `import { Kit } from "../lib";`, "<Kit.Forms.Dialog onSave={DROP} />"),
  "src/pages/OneHopPage.tsx": reactPage("OneHopPage", "saveHop", `import { Forms } from "../kit";`, "<Forms.Dialog onSave={DROP} />"),
  "src/pages/CjsPage.jsx": reactPage("CjsPage", "saveCjs", `const Kit = require("../kit/forms");`, "<Kit.Dialog onSave={DROP} />"),
  // Two files of the barrel's `export *` define the name: refused.
  "src/pages/TwinPage.tsx": reactPage("TwinPage", "saveTwin", `import { Twin } from "../kit";`, "<Twin onSave={DROP} />"),
  "src/pages/MissPage.tsx": reactPage("MissPage", "saveMiss", `import * as Kit from "../kit";`, "<Kit.Forms.Nothing onSave={DROP} />"),
};

const sfc = (n: string) => `<script setup lang="ts">\nconst emit = defineEmits<{ (e: "confirm"): void }>();\n</script>\n<template><button @click="emit('confirm')">${n}</button></template>\n`;
const VUE: Record<string, string> = {
  "package.json": `{"name":"club","dependencies":{"vue":"3"}}`,
  "src/ui/ConfirmDialog.vue": sfc("OK"),
  "src/ui/Other.vue": sfc("Other"),
  // A default re-export: the form Vue barrels use.
  "src/ui/index.ts": `export { default as ConfirmDialog } from "./ConfirmDialog.vue";\nexport { default as Other } from "./Other.vue";\n`,
  "src/pages/ClubPage.vue": vuePage("dropClub", `import { ConfirmDialog } from "../ui";`, `<ConfirmDialog @confirm="DROP" />`),
  "src/pages/MatchPage.vue": vuePage("dropMatch", `import { ConfirmDialog } from "../ui";`, `<ConfirmDialog @confirm="DROP" />`),
  "src/pages/ListPage.vue": `<script setup lang="ts">\nimport { ConfirmDialog } from "../ui";\n</script>\n<template><ConfirmDialog /></template>\n`,
};

describe("a component imported through a barrel", () => {
  let dir: string;
  let react: ProjectAnalysis;
  let vue: ProjectAnalysis;
  const run = async (name: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name, path)), { recursive: true });
      await writeFile(join(dir, name, path), text);
    }
    await analyze({ projectRoot: join(dir, name), outputDir: join(dir, `${name}-out`), lsp: false, gitHistory: false });
    return loadReportSummary(join(dir, `${name}-out`));
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-barrel-imports-"));
    react = await run("react", REACT);
    vue = await run("vue", VUE);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const into = (s: ProjectAnalysis, strategy: string, child: string) =>
    s.symbolLinks
      .filter((l) => l.sourceFile === child && l.strategy === strategy)
      .map((l) => `${l.targetFile.replace("src/pages/", "")}:${l.targetSymbol}`)
      .sort();

  it("binds the callback to the page that wrote the tag, under the name it imported", () => {
    expect(into(react, "dispatch:prop-callback", "src/ui/ConfirmDialog.tsx")).toEqual(["ClubPage.tsx:dropClub", "MatchPage.tsx:dropMatch"]);
    expect(into(react, "dispatch:prop-callback", "src/ui/Whistle.tsx")).toEqual(["RefPage.tsx:blow"]);
  });

  it("never reaches the namesake in another folder, or a member the barrel does not export", () => {
    expect(react.symbolLinks.filter((l) => l.targetFile === "src/other/ConfirmDialog.tsx" || l.sourceFile === "src/other/ConfirmDialog.tsx")).toEqual([]);
    expect(react.symbolLinks.filter((l) => l.sourceFile === "src/pages/GaragePage.tsx" && l.strategy?.startsWith("dispatch:"))).toEqual([]);
  });

  it("states that a page rendering the dialog without a binding renders it, so the gate tells it from the others", () => {
    const renders = react.symbolLinks.filter((l) => l.strategy === "dispatch:renders" && l.targetFile === "src/ui/ConfirmDialog.tsx").map((l) => l.sourceFile.replace("src/pages/", ""));
    expect(renders.sort()).toEqual(["ClubPage.tsx", "ListPage.tsx", "MatchPage.tsx"]);
    const gate = usageGate(react.symbolLinks);
    const child = keyOf("src/ui/ConfirmDialog.tsx", "ConfirmDialog");
    const state = gate.forward("", keyOf("src/pages/ClubPage.tsx", "ClubPage"), child)!;
    expect(gate.forward(state, child, keyOf("src/pages/MatchPage.tsx", "dropMatch"))).toBeNull();
    expect(gate.forward(state, child, keyOf("src/pages/ClubPage.tsx", "dropClub"))).not.toBeNull();
  });

  it("follows a Vue default re-export to the component file", () => {
    expect(into(vue, "dispatch:component-emit", "src/ui/ConfirmDialog.vue")).toEqual(["ClubPage.vue:dropClub", "MatchPage.vue:dropMatch"]);
    expect(vue.symbolLinks.filter((l) => l.targetFile === "src/ui/Other.vue" || l.sourceFile === "src/ui/Other.vue")).toEqual([]);
    expect(vue.symbolLinks.filter((l) => l.strategy === "dispatch:renders" && l.sourceFile === "src/pages/ListPage.vue").map((l) => l.targetFile)).toEqual(["src/ui/ConfirmDialog.vue"]);
  });

  it("follows nested namespaces, an `export * as` namespace and a CommonJS namespace to the member", () => {
    expect(into(react, "dispatch:prop-callback", "src/kit/forms/Dialog.tsx")).toEqual(["CjsPage.jsx:saveCjs", "NamedNsPage.tsx:saveNamed", "NestPage.tsx:saveNest", "OneHopPage.tsx:saveHop"]);
  });

  it("refuses a name two files of an `export *` both define, and a nested member nothing exports", () => {
    for (const page of ["TwinPage", "MissPage"]) {
      expect(react.symbolLinks.filter((l) => l.sourceFile === `src/pages/${page}.tsx` && l.strategy?.startsWith("dispatch:"))).toEqual([]);
    }
    expect(react.symbolLinks.filter((l) => l.strategy?.startsWith("dispatch:") && /dup[12]/.test(l.sourceFile + l.targetFile))).toEqual([]);
  });
});
