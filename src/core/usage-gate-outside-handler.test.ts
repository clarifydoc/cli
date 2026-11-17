import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";
import { findExportBundle } from "../export/index.js";
import type { Summary } from "../export/types.js";

/**
 * A shared confirm dialog two pages bind, where a page's handler is not one of the page's own functions: it is
 * imported from a module, or returned by a composable / hook. The page that states the binding keeps the
 * effect on its screen; the shared child's own screen lists none, and the other page lists only its own.
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
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-usage-gate-out-"));
  const root = join(dir, "league");
  for (const [path, text] of Object.entries({ "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "4.18.0", pg: "8.11.0" } }), "api/server.js": API, ...files })) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return { dir, summary: await loadReportSummary(join(dir, "out")) };
}

const tablesOf = (summary: ProjectAnalysis, file: string) =>
  [...new Set((summary.dataFlows ?? []).filter((f) => f.entryKind === "screen" && f.entryFile === file && f.effect.startsWith("db")).map((f) => f.resource))].sort();

const specs = (summary: ProjectAnalysis) =>
  new Map(findExportBundle("screens")!.render(summary as unknown as Summary).map((f) => [f.path, f.content]));

const REACT_DIALOG = [
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
].join("\n");
const VUE_DIALOG = [
  "<template>",
  '  <button @click="onConfirm">OK</button>',
  "</template>",
  "",
  '<script setup lang="ts">',
  'const emit = defineEmits<{ (e: "confirm"): void }>();',
  "function onConfirm() {",
  '  emit("confirm");',
  "}",
  "</script>",
].join("\n");

const webPkg = (extra: Record<string, string>) => JSON.stringify({ name: "league-web", dependencies: { axios: "1.6.0", ...extra } });

const cases: Array<{ name: string; ext: string; files: Record<string, string> }> = [
  {
    name: "React, handlers imported from a module",
    ext: "tsx",
    files: {
      "web/package.json": webPkg({ react: "18.2.0" }),
      "web/src/components/ConfirmDialog.tsx": REACT_DIALOG,
      "web/src/api/clubs.ts": ['import axios from "axios";', "export async function saveClub() {", '  await axios.post("/api/clubs", { name: "Rovers" });', "}"].join("\n"),
      "web/src/api/players.ts": ['import axios from "axios";', "export async function deletePlayer() {", "  await axios.delete(`/api/players/7`);", "}"].join("\n"),
      "web/src/pages/ClubPage.tsx": [
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        'import { saveClub } from "../api/clubs";',
        "export function ClubPage() {",
        '  return <ConfirmDialog message="Save club?" onConfirm={saveClub} />;',
        "}",
      ].join("\n"),
      "web/src/pages/PlayerPage.tsx": [
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        'import { deletePlayer } from "../api/players";',
        "export function PlayerPage() {",
        '  return <ConfirmDialog message="Release player?" onConfirm={deletePlayer} />;',
        "}",
      ].join("\n"),
    },
  },
  {
    name: "React, handlers returned by custom hooks",
    ext: "tsx",
    files: {
      "web/package.json": webPkg({ react: "18.2.0" }),
      "web/src/components/ConfirmDialog.tsx": REACT_DIALOG,
      "web/src/hooks/useClubs.ts": ['import axios from "axios";', "export function useClubs() {", "  const saveClub = async () => {", '    await axios.post("/api/clubs", { name: "Rovers" });', "  };", "  return { saveClub };", "}"].join("\n"),
      "web/src/hooks/usePlayers.ts": ['import axios from "axios";', "export function usePlayers() {", "  const deletePlayer = async () => {", "    await axios.delete(`/api/players/7`);", "  };", "  return { deletePlayer };", "}"].join("\n"),
      "web/src/pages/ClubPage.tsx": [
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        'import { useClubs } from "../hooks/useClubs";',
        "export function ClubPage() {",
        "  const { saveClub } = useClubs();",
        '  return <ConfirmDialog message="Save club?" onConfirm={saveClub} />;',
        "}",
      ].join("\n"),
      "web/src/pages/PlayerPage.tsx": [
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        'import { usePlayers } from "../hooks/usePlayers";',
        "export function PlayerPage() {",
        "  const { deletePlayer } = usePlayers();",
        '  return <ConfirmDialog message="Release player?" onConfirm={deletePlayer} />;',
        "}",
      ].join("\n"),
    },
  },
  {
    name: "Vue, handlers imported from a module",
    ext: "vue",
    files: {
      "web/package.json": webPkg({ vue: "3.4.0" }),
      "web/src/components/ConfirmDialog.vue": VUE_DIALOG,
      "web/src/api/clubs.ts": ['import axios from "axios";', "export async function saveClub() {", '  await axios.post("/api/clubs", { name: "Rovers" });', "}"].join("\n"),
      "web/src/api/players.ts": ['import axios from "axios";', "export async function deletePlayer() {", "  await axios.delete(`/api/players/7`);", "}"].join("\n"),
      "web/src/pages/ClubPage.vue": [
        "<template>",
        '  <ConfirmDialog @confirm="saveClub" />',
        "</template>",
        '<script setup lang="ts">',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        'import { saveClub } from "../api/clubs";',
        "</script>",
      ].join("\n"),
      "web/src/pages/PlayerPage.vue": [
        "<template>",
        '  <ConfirmDialog :on-confirm="deletePlayer" @confirm="deletePlayer" />',
        "</template>",
        '<script setup lang="ts">',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        'import { deletePlayer } from "../api/players";',
        "</script>",
      ].join("\n"),
    },
  },
  {
    name: "Vue, handlers returned by composables",
    ext: "vue",
    files: {
      "web/package.json": webPkg({ vue: "3.4.0" }),
      "web/src/components/ConfirmDialog.vue": VUE_DIALOG,
      "web/src/composables/useClubs.ts": ['import axios from "axios";', "export function useClubs() {", "  async function saveClub() {", '    await axios.post("/api/clubs", { name: "Rovers" });', "  }", "  return { saveClub };", "}"].join("\n"),
      "web/src/composables/usePlayers.ts": ['import axios from "axios";', "export function usePlayers() {", "  async function deletePlayer() {", "    await axios.delete(`/api/players/7`);", "  }", "  return { deletePlayer };", "}"].join("\n"),
      "web/src/pages/ClubPage.vue": [
        "<template>",
        '  <ConfirmDialog @confirm="saveClub" />',
        "</template>",
        '<script setup lang="ts">',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        'import { useClubs } from "../composables/useClubs";',
        "const { saveClub } = useClubs();",
        "</script>",
      ].join("\n"),
      "web/src/pages/PlayerPage.vue": [
        "<template>",
        '  <ConfirmDialog @confirm="deletePlayer" />',
        "</template>",
        '<script setup lang="ts">',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        'import { usePlayers } from "../composables/usePlayers";',
        "const { deletePlayer } = usePlayers();",
        "</script>",
      ].join("\n"),
    },
  },
  {
    name: "React, handlers read off a hook's result object",
    ext: "tsx",
    files: {
      "web/package.json": webPkg({ react: "18.2.0" }),
      "web/src/components/ConfirmDialog.tsx": REACT_DIALOG,
      "web/src/hooks/useClubs.ts": ['import axios from "axios";', "export function useClubs() {", "  return {", "    save: async () => {", '      await axios.post("/api/clubs", { name: "Rovers" });', "    },", "  };", "}"].join("\n"),
      "web/src/hooks/usePlayers.ts": ['import axios from "axios";', "export function usePlayers() {", "  return {", "    release: async () => {", "      await axios.delete(`/api/players/7`);", "    },", "  };", "}"].join("\n"),
      "web/src/pages/ClubPage.tsx": [
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        'import { useClubs } from "../hooks/useClubs";',
        "export function ClubPage() {",
        "  const clubs = useClubs();",
        '  return <ConfirmDialog message="Save club?" onConfirm={clubs.save} />;',
        "}",
      ].join("\n"),
      "web/src/pages/PlayerPage.tsx": [
        'import { ConfirmDialog } from "../components/ConfirmDialog";',
        'import { usePlayers } from "../hooks/usePlayers";',
        "export function PlayerPage() {",
        "  const players = usePlayers();",
        '  return <ConfirmDialog message="Release player?" onConfirm={players.release} />;',
        "}",
      ].join("\n"),
    },
  },
  {
    name: "Vue, handlers read off a composable's result object",
    ext: "vue",
    files: {
      "web/package.json": webPkg({ vue: "3.4.0" }),
      "web/src/components/ConfirmDialog.vue": VUE_DIALOG,
      "web/src/composables/useClubs.ts": ['import axios from "axios";', "export function useClubs() {", "  async function save() {", '    await axios.post("/api/clubs", { name: "Rovers" });', "  }", "  return { save };", "}"].join("\n"),
      "web/src/composables/usePlayers.ts": ['import axios from "axios";', "export function usePlayers() {", "  async function release() {", "    await axios.delete(`/api/players/7`);", "  }", "  return { release };", "}"].join("\n"),
      "web/src/pages/ClubPage.vue": [
        "<template>",
        '  <ConfirmDialog @confirm="clubs.save" />',
        "</template>",
        '<script setup lang="ts">',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        'import { useClubs } from "../composables/useClubs";',
        "const clubs = useClubs();",
        "</script>",
      ].join("\n"),
      "web/src/pages/PlayerPage.vue": [
        "<template>",
        '  <ConfirmDialog @confirm="players.release" />',
        "</template>",
        '<script setup lang="ts">',
        'import ConfirmDialog from "../components/ConfirmDialog.vue";',
        'import { usePlayers } from "../composables/usePlayers";',
        "const players = usePlayers();",
        "</script>",
      ].join("\n"),
    },
  },
  {
    name: "React, an imported handler handed through a panel to the dialog",
    ext: "tsx",
    files: {
      "web/package.json": webPkg({ react: "18.2.0" }),
      "web/src/components/ConfirmDialog.tsx": REACT_DIALOG,
      "web/src/components/ClubPanel.tsx": [
        'import { ConfirmDialog } from "./ConfirmDialog";',
        "export function ClubPanel({ onSave }: { onSave: () => void }) {",
        '  return <ConfirmDialog message="Sure?" onConfirm={onSave} />;',
        "}",
      ].join("\n"),
      "web/src/api/clubs.ts": ['import axios from "axios";', "export async function saveClub() {", '  await axios.post("/api/clubs", { name: "Rovers" });', "}"].join("\n"),
      "web/src/api/players.ts": ['import axios from "axios";', "export async function deletePlayer() {", "  await axios.delete(`/api/players/7`);", "}"].join("\n"),
      "web/src/pages/ClubPage.tsx": [
        'import { ClubPanel } from "../components/ClubPanel";',
        'import { saveClub } from "../api/clubs";',
        "export function ClubPage() {",
        "  return <ClubPanel onSave={saveClub} />;",
        "}",
      ].join("\n"),
      "web/src/pages/PlayerPage.tsx": [
        'import { ClubPanel } from "../components/ClubPanel";',
        'import { deletePlayer } from "../api/players";',
        "export function PlayerPage() {",
        "  return <ClubPanel onSave={deletePlayer} />;",
        "}",
      ].join("\n"),
    },
  },
];

describe.each(cases)("a handler defined outside the page ($name)", ({ ext, files }) => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    ({ dir, summary } = await project(files));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links the dialog's callback or emit to each page's handler where the engine links it at all", () => {
    // The page's own binding site names the handler, so its screen never depends on the child's bound link.
    expect(summary.symbolLinks.some((l) => l.targetFile.startsWith("web/src/") && !l.sourceFile.includes("ConfirmDialog") && /^(clubs|players|useClubs|usePlayers)\./.test(l.targetFile.split("/").pop()!))).toBe(true);
  });

  it("keeps each page's screen to the effect of the handler it binds", () => {
    expect(tablesOf(summary, `web/src/pages/ClubPage.${ext}`)).toEqual(["clubs"]);
    expect(tablesOf(summary, `web/src/pages/PlayerPage.${ext}`)).toEqual(["players"]);
  });

  it("lists nothing on the shared dialog's own screen", () => {
    expect(tablesOf(summary, `web/src/components/ConfirmDialog.${ext}`)).toEqual([]);
  });

  it("gives each page's screen spec its own request and the dialog's none", () => {
    const files = specs(summary);
    const spec = (n: string) => files.get(`screens/${n}.md`) ?? "";
    expect(spec("ClubPage")).toContain("/api/clubs");
    expect(spec("ClubPage")).not.toContain("/api/players");
    expect(spec("PlayerPage")).toContain("/api/players");
    expect(spec("PlayerPage")).not.toContain("/api/clubs");
    expect(spec("ConfirmDialog")).not.toMatch(/api\/(clubs|players)/);
  });
});
