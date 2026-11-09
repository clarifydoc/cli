import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A shared confirm dialog two pages use, each binding its own handler: the club page's
 * confirm saves a club (POST /api/clubs → clubs), the player page's deletes a player
 * (DELETE /api/players/:id → players). The dialog's emit is one link per binding, so a
 * walk entering the dialog from one page must leave it only to that page's handler.
 */
const API = [
  'const express = require("express");',
  'const { Pool } = require("pg");',
  "const app = express();",
  "const pool = new Pool();",
  'app.post("/api/clubs", async (req, res) => {',
  '  await pool.query("INSERT INTO clubs (name) VALUES ($1)", [req.body.name]);',
  "  res.sendStatus(201);",
  "});",
  'app.delete("/api/players/:id", async (req, res) => {',
  '  await pool.query("DELETE FROM players WHERE id = $1", [req.params.id]);',
  "  res.sendStatus(204);",
  "});",
  "app.listen(3000);",
].join("\n");

async function project(files: Record<string, string>): Promise<{ dir: string; summary: ProjectAnalysis }> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-usage-gate-"));
  const root = join(dir, "league");
  for (const [path, text] of Object.entries({ "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "4.18.0", pg: "8.11.0" } }), "api/server.js": API, ...files })) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return { dir, summary: await loadReportSummary(join(dir, "out")) };
}

/** The tables a screen's data flows reach. */
const tablesOf = (summary: ProjectAnalysis, file: string) =>
  [...new Set((summary.dataFlows ?? []).filter((f) => f.entryKind === "screen" && f.entryFile === file && f.effect.startsWith("db")).map((f) => f.resource))].sort();

describe("an emit returns to the usage it came in by (React callback props)", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    ({ dir, summary } = await project({
      "web/package.json": JSON.stringify({ name: "league-web", dependencies: { react: "18.2.0", "react-router-dom": "6.20.0", axios: "1.6.0" } }),
      "web/src/components/ConfirmDialog.tsx": [
        "interface ConfirmDialogProps {",
        "  message: string;",
        "  onConfirm: () => void;",
        "}",
        "export function ConfirmDialog({ message, onConfirm }: ConfirmDialogProps) {",
        "  return (",
        "    <div>",
        "      <p>{message}</p>",
        "      <button onClick={() => onConfirm()}>OK</button>",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
      "web/src/pages/ClubPage.tsx": [
        'import axios from "axios";',
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        "export function ClubPage() {",
        "  async function saveClub() {",
        '    await axios.post("/api/clubs", { name: "Rovers" });',
        "  }",
        '  return <ConfirmDialog message="Save club?" onConfirm={saveClub} />;',
        "}",
      ].join("\n"),
      "web/src/pages/PlayerPage.tsx": [
        'import axios from "axios";',
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        "const playerId = 7;",
        "export function PlayerPage() {",
        "  async function deletePlayer() {",
        "    await axios.delete(`/api/players/${playerId}`);",
        "  }",
        '  return <ConfirmDialog message="Release player?" onConfirm={deletePlayer} />;',
        "}",
      ].join("\n"),
      "web/src/App.tsx": [
        'import { BrowserRouter, Routes, Route } from "react-router-dom";',
        'import { ClubPage } from "./pages/ClubPage";',
        'import { PlayerPage } from "./pages/PlayerPage";',
        "export function App() {",
        "  return (",
        "    <BrowserRouter>",
        "      <Routes>",
        '        <Route path="/clubs" element={<ClubPage />} />',
        '        <Route path="/players" element={<PlayerPage />} />',
        "      </Routes>",
        "    </BrowserRouter>",
        "  );",
        "}",
      ].join("\n"),
    }));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tags each callback link with the tag that binds it", () => {
    const bound = summary.symbolLinks.filter((l) => l.sourceFile === "web/src/components/ConfirmDialog.tsx" && l.relation === "dispatch");
    expect(bound.map((l) => [l.targetSymbol, l.viaUsage]).sort()).toEqual([
      ["deletePlayer", [{ file: "web/src/pages/PlayerPage.tsx", line: 8 }]],
      ["saveClub", [{ file: "web/src/pages/ClubPage.tsx", line: 7 }]],
    ]);
  });

  it("keeps each page to its own handler's table", () => {
    expect(tablesOf(summary, "web/src/pages/ClubPage.tsx")).toEqual(["clubs"]);
    expect(tablesOf(summary, "web/src/pages/PlayerPage.tsx")).toEqual(["players"]);
  });

  it("lets the dialog alone and the app rendering both pages reach both tables", () => {
    expect(tablesOf(summary, "web/src/components/ConfirmDialog.tsx")).toEqual(["clubs", "players"]);
    expect(tablesOf(summary, "web/src/App.tsx")).toEqual(["clubs", "players"]);
  });

  it("drops the other page's handler from the page's own reach", () => {
    const reach = (symbol: string) => summary.symbolReach?.find((r) => r.file.endsWith(`${symbol}.tsx`) && r.symbol === symbol)?.effects.map((e) => e.resource).sort();
    expect(reach("ClubPage")).toEqual(["/api/clubs", "clubs"]);
    expect(reach("PlayerPage")).toEqual(["/api/players/${playerId}", "players"]);
  });
});

describe("an emit returns to the usage it came in by (Vue template refs)", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    ({ dir, summary } = await project({
      "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", "vue-router": "4.2.0", axios: "1.6.0" } }),
      "web/src/components/ConfirmDialog.vue": [
        "<template>",
        "  <div>",
        "    <p>{{ message }}</p>",
        '    <button @click="onConfirm">OK</button>',
        "  </div>",
        "</template>",
        "",
        '<script setup lang="ts">',
        "defineProps<{ message: string }>();",
        'const emit = defineEmits<{ (e: "confirm"): void }>();',
        "function onConfirm() {",
        '  emit("confirm");',
        "}",
        "defineExpose({ onConfirm });",
        "</script>",
      ].join("\n"),
      "web/src/pages/ClubPage.vue": [
        "<template>",
        "  <div>",
        '    <button @click="quickSave">Quick save</button>',
        '    <ConfirmDialog ref="dialog" message="Save club?" @confirm="saveClub" />',
        "  </div>",
        "</template>",
        "",
        '<script setup lang="ts">',
        'import { ref } from "vue";',
        'import axios from "axios";',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        "const dialog = ref<InstanceType<typeof ConfirmDialog>>();",
        "function quickSave() {",
        "  dialog.value?.onConfirm();",
        "}",
        "async function saveClub() {",
        '  await axios.post("/api/clubs", { name: "Rovers" });',
        "}",
        "</script>",
      ].join("\n"),
      "web/src/pages/PlayerPage.vue": [
        "<template>",
        '  <ConfirmDialog message="Release player?" @confirm="deletePlayer" />',
        "</template>",
        "",
        '<script setup lang="ts">',
        'import axios from "axios";',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        "const playerId = 7;",
        "async function deletePlayer() {",
        "  await axios.delete(`/api/players/${playerId}`);",
        "}",
        "</script>",
      ].join("\n"),
      // Calls into the dialog through its ref, but binds its confirm in place: no handler of its own to return to.
      "web/src/pages/MatchPage.vue": [
        "<template>",
        "  <div>",
        '    <button @click="skip">Skip</button>',
        '    <ConfirmDialog ref="dialog" message="Kick off?" @confirm="kickedOff = true" />',
        "  </div>",
        "</template>",
        "",
        '<script setup lang="ts">',
        'import { ref } from "vue";',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        "const dialog = ref<InstanceType<typeof ConfirmDialog>>();",
        "const kickedOff = ref(false);",
        "function skip() {",
        "  dialog.value?.onConfirm();",
        "}",
        "</script>",
      ].join("\n"),
      "web/src/router.ts": [
        'import { createRouter, createWebHistory } from "vue-router";',
        'import ClubPage from "./pages/ClubPage.vue";',
        'import PlayerPage from "./pages/PlayerPage.vue";',
        "export const router = createRouter({",
        "  history: createWebHistory(),",
        "  routes: [",
        '    { path: "/clubs", component: ClubPage },',
        '    { path: "/players", component: PlayerPage },',
        "  ],",
        "});",
      ].join("\n"),
    }));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tags each emit link with the tag that binds it", () => {
    const bound = summary.symbolLinks.filter((l) => l.callName === "emit:confirm");
    expect(bound.map((l) => [l.targetSymbol, l.viaUsage]).sort()).toEqual([
      ["deletePlayer", [{ file: "web/src/pages/PlayerPage.vue", line: 2 }]],
      ["saveClub", [{ file: "web/src/pages/ClubPage.vue", line: 4 }]],
    ]);
  });

  it("returns a page's call into the dialog to that page's handler only", () => {
    expect(summary.symbolLinks.some((l) => l.sourceSymbol === "quickSave" && l.targetSymbol === "onConfirm")).toBe(true);
    expect(tablesOf(summary, "web/src/pages/ClubPage.vue")).toEqual(["clubs"]);
    expect(tablesOf(summary, "web/src/components/ConfirmDialog.vue")).toEqual(["clubs", "players"]);
  });

  it("leaves the dialog through no page's handler for a page that calls into it but binds the event nowhere", () => {
    expect(summary.symbolLinks.some((l) => l.sourceSymbol === "skip" && l.targetSymbol === "onConfirm")).toBe(true);
    expect(tablesOf(summary, "web/src/pages/MatchPage.vue")).toEqual([]);
  });
});
