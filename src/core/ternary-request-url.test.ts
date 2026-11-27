import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A request whose URL is `editing ? "/clubs/update" : "/clubs/add"` reaches both routes: each is a
 * variant link (AMBIGUOUS), and each keeps its trace edge, so the screen reaches the tables both write
 * (real-repo shape: an edit-or-create form).
 */
const FILES: Record<string, string> = {
  "front/package.json": JSON.stringify({ name: "league-ui", dependencies: { vue: "3.4.0", axios: "1.6.0" } }),
  "front/src/api.ts": `import axios from "axios";\nexport default axios.create({ baseURL: "/api" });\n`,
  "front/src/views/ClubForm.vue": `<template><button @click="save">Save</button></template>
<script setup lang="ts">
import { ref } from "vue";
import api from "../api";
const isEditing = ref(false);
const club = ref({ name: "" });
const save = async () => {
  await api.post(isEditing.value ? \`/clubs/update\` : "/clubs/add", club.value);
};
const label = async () => {
  await api.post("/clubs/label", { mode: isEditing.value ? "edit" : "add" });
};
</script>
`,
  "back/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "4.18.0", sequelize: "6.0.0" } }),
  "back/src/server.ts": `import express from "express";
import { Club, Player, Trophy } from "./models";
const app = express();
app.post("/api/clubs/update", async (req, res) => { await Club.update(req.body, { where: { id: 1 } }); res.send("ok"); });
app.post("/api/clubs/add", async (req, res) => { await Player.create(req.body); res.send("ok"); });
app.post("/api/clubs/label", async (req, res) => { await Trophy.create(req.body); res.send("ok"); });
`,
  "back/src/models.ts": `import { Model } from "sequelize";
export class Club extends Model {}
export class Player extends Model {}
export class Trophy extends Model {}
`,
};

describe("a request whose URL is a conditional over two literals", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ternary-url-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links one AMBIGUOUS variant per route, and the body-only conditional links only its own route", () => {
    const links = (summary.apiRouteLinks ?? []).filter((l) => l.source.endsWith("ClubForm.vue"));
    const by = (url: string) => links.filter((l) => l.url === url).map((l) => l.confidence);
    expect(by("/clubs/update")).toEqual(["AMBIGUOUS"]);
    expect(by("/clubs/add")).toEqual(["AMBIGUOUS"]);
    expect(by("/clubs/label")).toHaveLength(1);
    expect(by("/clubs/label")).not.toContain("AMBIGUOUS");
  });

  it("gives each variant a trace edge from the screen's function to its route", () => {
    const edges = (summary.symbolLinks ?? []).filter((l) => l.strategy === "api-route" && l.sourceFile.endsWith("ClubForm.vue") && l.sourceLine === 8);
    expect(edges.map((l) => l.callName).sort()).toEqual(["POST /api/clubs/add", "POST /api/clubs/update"]);
    expect(edges.every((l) => l.confidence === "AMBIGUOUS")).toBe(true);
  });

  it("lets the screen reach the tables both routes write, and not the decoy route's", () => {
    const writes = (summary.dataFlows ?? []).filter((f) => f.entryKind === "screen" && String(f.entryFile).endsWith("ClubForm.vue") && f.effect === "db-write").map((f) => f.resource);
    expect(writes).toContain("Club");
    expect(writes).toContain("Player");
    // The body-only conditional stays one plain call: it reaches its own route once, and nothing else.
    const label = (summary.symbolLinks ?? []).filter((l) => l.strategy === "api-route" && l.sourceFile.endsWith("ClubForm.vue") && l.sourceLine === 11);
    expect(label.map((l) => l.callName)).toEqual(["POST /api/clubs/label"]);
  });
});
