import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { keyOf, usageGate } from "../../../core/symbol-graph.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const page = (name: string, drop: string, tag: string, imp: string) => `${imp}
export function ${name}() {
  const ${drop} = async () => { await fetch("/api/${drop}/1", { method: "DELETE" }); };
  return ${tag.replace("DROP", drop)};
}
`;

const FILES: Record<string, string> = {
  "package.json": `{"name":"club","dependencies":{"react":"18"}}`,
  "src/ui/ConfirmDialog.tsx": `export function ConfirmDialog({ onConfirm }: { onConfirm: () => void }) {
  return <button onClick={() => onConfirm()}>OK</button>;
}
`,
  "src/ui/index.ts": `export { ConfirmDialog } from "./ConfirmDialog";\n`,
  "src/ui/Dialogs.tsx": `export function Confirm({ onConfirm }: { onConfirm: () => void }) {
  return <button onClick={() => onConfirm()}>Sure</button>;
}
export function Other() { return <i />; }
`,
  // A namespace over a barrel, a namespace over the file itself, and a plain named import.
  "src/pages/ClubPage.tsx": page("ClubPage", "dropClub", "<UI.ConfirmDialog onConfirm={DROP} />", `import * as UI from "../ui";`),
  "src/pages/MatchPage.tsx": page("MatchPage", "dropMatch", "<Dialogs.Confirm onConfirm={DROP} />", `import * as Dialogs from "../ui/Dialogs";`),
  "src/pages/PlayerPage.tsx": page("PlayerPage", "dropPlayer", "<ConfirmDialog onConfirm={DROP} />", `import { ConfirmDialog } from "../ui/ConfirmDialog";`),
  // The namespace has no such member: a leaf-name guess would find the shared dialog.
  "src/pages/GaragePage.tsx": page("GaragePage", "dropGarage", "<UI.Missing onConfirm={DROP} />", `import * as UI from "../ui";`),
};

describe("a namespaced or member JSX tag", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-namespace-tags-"));
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

  const emitsInto = (child: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === child && l.strategy === "dispatch:prop-callback")
      .map((l) => `${l.targetFile.replace("src/pages/", "")}:${l.targetSymbol}`)
      .sort();

  it("binds the child's callback to the parent that wrote the tag, through a barrel or the file itself", () => {
    expect(emitsInto("src/ui/ConfirmDialog.tsx")).toEqual(["ClubPage.tsx:dropClub", "PlayerPage.tsx:dropPlayer"]);
    expect(emitsInto("src/ui/Dialogs.tsx")).toEqual(["MatchPage.tsx:dropMatch"]);
  });

  it("states that the namespaced parent renders the child, so the gate tells it from the others", () => {
    const renders = summary.symbolLinks
      .filter((l) => l.strategy === "dispatch:renders")
      .map((l) => `${l.sourceFile.replace("src/pages/", "")}>${l.targetFile.replace("src/ui/", "")}`)
      .sort();
    expect(renders).toEqual(["ClubPage.tsx>ConfirmDialog.tsx", "MatchPage.tsx>Dialogs.tsx", "PlayerPage.tsx>ConfirmDialog.tsx"]);
  });

  it("leaves a member the namespace does not export unresolved", () => {
    expect(summary.symbolLinks.filter((l) => l.sourceFile === "src/pages/GaragePage.tsx" && l.strategy?.startsWith("dispatch:"))).toEqual([]);
  });

  it("keeps a page out of another page's handler through the shared dialog", () => {
    const gate = usageGate(summary.symbolLinks);
    const dialog = keyOf("src/ui/ConfirmDialog.tsx", "ConfirmDialog");
    const club = keyOf("src/pages/ClubPage.tsx", "ClubPage");
    const state = gate.forward("", club, dialog)!;
    const player = gate.forward(state, dialog, keyOf("src/pages/PlayerPage.tsx", "dropPlayer"));
    const own = gate.forward(state, dialog, keyOf("src/pages/ClubPage.tsx", "dropClub"));
    expect(player).toBeNull();
    expect(own).not.toBeNull();
  });
});
