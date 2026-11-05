import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A page composable that hands back a sub-composable's members by spreading
 * its result (`const crud = useSquadCrud(); return { ...crud, benchAll }`),
 * held in a local the page destructures (`const squadPage = useSquadPage(id);
 * const { signPlayer } = squadPage`) — real-repo shape. The page's handler is
 * the sub-composable's function, never the whole page composable.
 */
const FILES: Record<string, string> = {
  "package.json": '{"name":"squad-web","dependencies":{"vue":"3.4.0","axios":"1.6.0"}}',
  "src/composables/use-squad-crud.ts": `import axios from "axios";
import { ref } from "vue";

export function useSquadCrud() {
  const order = ref(null);
  async function signPlayer(player) {
    await axios.post("/api/v2/players", player);
  }
  function cancelOrder() {
    order.value = null;
  }
  return { order, signPlayer, cancelOrder };
}
`,
  "src/composables/use-squad-page.ts": `import { useSquadCrud } from "./use-squad-crud";

export function useSquadPage(clubId) {
  const crud = useSquadCrud();
  function benchAll() {
    return clubId;
  }
  return { ...crud, benchAll };
}
`,
  "src/pages/Squad.vue": `<template>
  <button @click="signPlayer(player)">Sign</button>
  <button @click="cancelOrder">Cancel</button>
  <button @click="benchAll">Bench</button>
</template>

<script setup lang="ts">
import { useSquadPage } from "../composables/use-squad-page";

const squadPage = useSquadPage(7);
const { signPlayer, cancelOrder, benchAll } = squadPage;
</script>
`,
};

describe("members a composable returns by spreading a sub-composable's result", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-spread-members-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links a destructured handler to the sub-composable's function, not the page composable", async () => {
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "src/pages/Squad.vue" && ["signPlayer", "cancelOrder", "benchAll"].includes(l.callName ?? ""));
    expect(links.map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`).sort()).toEqual([
      "benchAll -> src/composables/use-squad-page.ts::benchAll",
      "cancelOrder -> src/composables/use-squad-crud.ts::cancelOrder",
      "signPlayer -> src/composables/use-squad-crud.ts::signPlayer",
    ]);
  });
});
