import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { jsTestCommand } from "../extractors/plugins/javascript/test-command.js";

/**
 * Component stories (Histoire `*.story.vue`, Storybook `*.stories.tsx`) render a component with stub
 * data for a tool. They used to be screens, and their buttons clicks of the app (real-repo FP: a
 * story's `@edit="onEdit"` stub reaching nothing). They are a harness like a test: no screen, no
 * click — and the component only a story renders still counts as used.
 */
describe("component stories", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-stories-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-ui","dependencies":{"vue":"3.4.0","vue-router":"4.2.0","react":"18.0.0"}}');
    await file("src/main.ts", 'import { createApp } from "vue";\nimport App from "./App.vue";\ncreateApp(App).mount("#app");\n');
    await file("src/App.vue", '<template>\n  <div><button @click="reload">Reload</button></div>\n</template>\n<script setup lang="ts">\nfunction reload() { fetch("/api/v2/clubs"); }\n</script>\n');
    await file("src/components/ClubCard.vue", '<template>\n  <div class="club"><button @click="$emit(\'edit\')">Edit</button></div>\n</template>\n<script setup lang="ts">\ndefineEmits(["edit"]);\n</script>\n');
    await file(
      "src/components/ClubCard.story.vue",
      '<template>\n  <Story title="Club card">\n    <ClubCard @edit="onEdit" />\n    <button @click="onEdit">Stub</button>\n  </Story>\n</template>\n<script setup lang="ts">\nimport ClubCard from "./ClubCard.vue";\nconst onEdit = () => {};\n</script>\n',
    );
    await file("src/components/PlayerBadge.tsx", 'export function PlayerBadge() {\n  return <span>Player</span>;\n}\n');
    await file(
      "src/components/PlayerBadge.stories.tsx",
      'import { PlayerBadge } from "./PlayerBadge";\nexport default { title: "Player badge" };\nexport const Default = () => <div><PlayerBadge /><button onClick={() => {}}>Stub</button></div>;\n',
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are no screen and declare no click", async () => {
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const screens = (summary.screens ?? []).map((s) => s.filePath);
    expect(screens).toContain("src/App.vue");
    expect(screens.filter((f) => /\.stor(y|ies)\./.test(f))).toEqual([]);
    const clickFiles = new Set((summary.interactiveElements ?? []).map((e) => e.filePath));
    expect(clickFiles.has("src/App.vue")).toBe(true);
    expect([...clickFiles].filter((f) => /\.stor(y|ies)\./.test(f))).toEqual([]);
    expect(summary.fileLayerMap?.["src/components/ClubCard.story.vue"]).toBe("test");
  });

  it("keep the components they render alive", async () => {
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    expect(summary.deadCode?.judgedFiles).toBeGreaterThan(0);
    const dead = (summary.deadCode?.files ?? []).map((f) => f.filePath);
    expect(dead).not.toContain("src/components/ClubCard.vue");
    expect(dead).not.toContain("src/components/PlayerBadge.tsx");
  });

  it("are not handed to the unit test runner", () => {
    const ctx = { packages: new Set(["vitest"]) } as never;
    expect(jsTestCommand([{ file: "src/components/ClubCard.story.vue" }] as never, ctx)).toBeNull();
    expect(jsTestCommand([{ file: "src/components/ClubCard.story.vue" }, { file: "src/club.test.ts" }] as never, ctx)).toBe("npx vitest run src/club.test.ts");
  });
});
