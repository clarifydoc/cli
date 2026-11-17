import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { SymbolLink } from "../types/analysis.js";

/**
 * A store picked by an immediately invoked function around a `switch` on a prop. The users bind one kind
 * (`club`), so the player store is a decoy no link may reach; a second picker whose `default` returns a store
 * too holds an entry with no readable key, so it reaches every store.
 */
const picker = (name: string, fallback: string) =>
  [
    "<template>",
    '  <button @click="load">Load</button>',
    "</template>",
    '<script setup lang="ts">',
    "import { useClubStore } from './use-club-store';",
    "import { usePlayerStore } from './use-player-store';",
    "const props = defineProps<{ kind: string }>();",
    "const store = (() => {",
    "  switch (props.kind) {",
    "    case 'club':",
    "      return useClubStore();",
    "    case 'player':",
    "      return usePlayerStore();",
    "    default:",
    `      ${fallback}`,
    "  }",
    "})();",
    "function load() {",
    "  store.load();",
    "}",
    "</script>",
  ].join("\n");

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", axios: "1.6.0" } }),
  "src/main.js": "import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');\n",
  "src/App.vue": "<template>\n  <Desk />\n</template>\n<script setup>\nimport Desk from './Desk.vue';\n</script>\n",
  "src/Desk.vue": '<template>\n  <Picker kind="club" />\n  <AnyPicker kind="club" />\n</template>\n<script setup>\nimport Picker from \'./Picker.vue\';\nimport AnyPicker from \'./AnyPicker.vue\';\n</script>\n',
  "src/Picker.vue": picker("Picker", "throw new Error('no store');"),
  "src/AnyPicker.vue": picker("AnyPicker", "return useCoachStore();").replace("import { usePlayerStore }", "import { useCoachStore } from './use-coach-store';\nimport { usePlayerStore }"),
};
for (const s of ["Club", "Player", "Coach"]) {
  const l = s.toLowerCase();
  FILES[`src/use-${l}-store.ts`] = [`import axios from 'axios';`, `export function use${s}Store() {`, `  return { load() { return axios.get('/api/v2/${l}s'); } };`, "}"].join("\n");
}

describe("a store picked by an IIFE switch on a prop, end to end", () => {
  let dir: string;
  let links: SymbolLink[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-store-iife-"));
    const root = join(dir, "web");
    for (const [path, src] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), src);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    links = (await loadReportSummary(join(dir, "out"))).symbolLinks ?? [];
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reached = (file: string) =>
    links
      .filter((l) => l.sourceFile === file && l.sourceSymbol === "load" && l.callName === "store.load")
      .map((l) => `${l.targetFile} via ${(l.viaUsage ?? []).map((u) => `${u.file}:${u.line}`).join(",")}`)
      .sort();

  it("reaches only the store the users' binding names, kept to that binding", () => {
    expect(reached("src/Picker.vue")).toEqual(["src/use-club-store.ts via src/Desk.vue:2"]);
  });

  it("reaches every store when a `default` returns one (an unreadable key)", () => {
    expect(reached("src/AnyPicker.vue").map((r) => r.split(" ")[0])).toEqual(["src/use-club-store.ts", "src/use-coach-store.ts", "src/use-player-store.ts"]);
  });
});
