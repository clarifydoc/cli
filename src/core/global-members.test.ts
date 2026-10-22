import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Real-repo FP: `app.config.globalProperties.$session = $session` — 53 `this.$session.x()` calls in components linked nowhere. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-ui", dependencies: { vue: "3.4.0" } }),
  "src/common/session.js": `export default class Session {
  login(username, password) {
    return fetch("/api/v1/session", { method: "POST" });
  }
}
`,
  "src/app/session.js": `import { reactive } from "vue";
import Session from "common/session";

export const $session = reactive(new Session());
`,
  "src/app.js": `import { createApp } from "vue";
import { $session } from "app/session";
import App from "app.vue";

const app = createApp(App);
app.config.globalProperties.$session = $session;
app.mount("#app");
`,
  "src/page/login.vue": `<template><button @click="login">Sign in</button></template>
<script>
export default {
  methods: {
    login() {
      return this.$session.login(this.username, this.password);
    },
  },
};
</script>
`,
};

describe("a member installed on every component instance", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-global-members-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is the installing module's binding, typed where it is declared", () => {
    const link = summary.symbolLinks.find((l) => l.sourceFile === "src/page/login.vue" && l.callName === "this.$session.login");
    expect(link && `${link.targetFile} ${link.targetSymbol}`).toBe("src/common/session.js Session.login");
  });
});
