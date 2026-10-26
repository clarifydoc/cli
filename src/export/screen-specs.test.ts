import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { posix, resolve } from "path";
import { denormalizeProject } from "../core/element-registry.js";
import { findExportBundle } from "./index.js";
import type { Summary } from "./types.js";

// Read the summary itself: through `loadReportSummary` a fixture's older lsp-enhancement.json (the fixtures pin
// `analyzedAt` to 1970, so its age guard never fires) replaces the symbol links, HTTP hops and all.
const load = (fixture: string) =>
  denormalizeProject(JSON.parse(readFileSync(resolve(__dirname, "../../test-output", fixture, "project-summary.json"), "utf8"))) as unknown as Summary;

describe("Screen specs", () => {
  const summary = load("sample-react");
  const files = findExportBundle("screens")!.render(summary);
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("writes an index, a spec per screen and a file per flow, every link landing on one of them", () => {
    expect(files[0]!.path).toBe("README.md");
    expect(files.filter((f) => f.path.startsWith("screens/")).length).toBe(summary.screens!.length);
    expect(files.some((f) => f.path.startsWith("flows/"))).toBe(true);
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    for (const f of files) expect(f.path, f.path).toMatch(/^[A-Za-z0-9._/-]+\.md$/);
    for (const f of files) {
      for (const m of f.content.matchAll(/\]\(([^)]+\.md)\)/g)) {
        const target = posix.normalize(posix.join(posix.dirname(f.path), m[1]!));
        expect(byPath.has(target), `${f.path} → ${m[1]}`).toBe(true);
      }
    }
  });

  it("says what a page loads apart from what its controls do, and follows each control to its route and table", () => {
    const parts = byPath.get("screens/PartsPage.md")!;
    const loads = parts.slice(parts.indexOf("## What it loads"), parts.indexOf("## Fields"));
    expect(loads).toContain("Sends `GET /api/parts`, handled at `backend/src/routes/parts.ts:11`");
    // The delete button is PartList's action, not something the page does when it opens.
    expect(loads).not.toContain("DELETE");
    expect(parts).toContain("## Fields\n\n- Change the input → `setName` (line 20)");
    expect(parts).toContain("### 1. Submit the form → `handleSubmit`\n\n`onSubmit` at `frontend/src/pages/PartsPage.tsx:19`\n\n- Sends `POST /api/parts`, handled at `backend/src/routes/parts.ts:22`\n- Writes `parts`");
    expect(parts).toContain("## What the user can do in its components\n\n- [PartList](PartList.md) — delete `parts`");
    expect(parts).toContain("- As a user, I can create `parts` on **PartsPage** (submit the form).");

    // A component's callback props belong to the page that renders it.
    expect(byPath.get("screens/Pagination.md")).toContain("Handed to the page that renders it ([GamesPage](GamesPage.md), [PlayersPage](PlayersPage.md)):");
  });

  it("reaches a component's action through the page that renders it, and names a flow by its handler", () => {
    const del = byPath.get("flows/Delete-parts.md")!;
    expect(del).toContain("2. Go to [PartsPage](../screens/PartsPage.md).\n3. On it, find [PartList](../screens/PartList.md).\n4. Click the button (runs `handleDelete`, `frontend/src/components/PartList.tsx:27`).\n5. Sends `DELETE /api/parts/:id`");
    expect(del).toContain("As a user, I can delete `parts` from **PartList** on **PartsPage**.");

    const create = byPath.get("flows/Create-player.md")!;
    expect(create).toMatch(/^---\ntype: "flow"\ngoal: "Create player"\n/);
    expect(create).toContain("Sends `POST /api/players`, handled by `createPlayer` at `PlayerController.java:26`.");

    const index = byPath.get("README.md")!;
    expect(index).toContain("### parts\n\n- [Create parts](flows/Create-parts.md) — / (frontend/src/App.tsx) → PartsPage\n- [Delete parts](flows/Delete-parts.md) — / (frontend/src/App.tsx) → PartsPage → PartList");
  });

  it("writes an index and nothing else for an analysis without screens", () => {
    const empty = findExportBundle("screens")!.render({});
    expect(empty.map((f) => f.path)).toEqual(["README.md"]);
    expect(empty[0]!.content).toContain("0 screens");
  });
});
