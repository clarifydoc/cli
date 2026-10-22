import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: an admin page's 17 buttons bound by attribute selector from the script it loads; every button had a null handler. */
const FILES: Record<string, string> = {
  "static/templates/admin/clubs.hbs": `<table id="clubs-table">
{{#each page_data}}
<tr>
  <td>{{name}}</td>
  <td>
    <button type="button" class="btn btn-sm" vw-delete-club>Delete club</button>
    <button type="button" class="btn btn-sm" vw-relegate-club>Relegate</button>
    <button type="button" class="btn btn-sm" data-action="promote">Promote</button>
  </td>
</tr>
{{/each}}
</table>
<button id="reload-table" type="button">Reload</button>
<script src="{{urlpath}}/static/admin.js"></script>
<script src="{{urlpath}}/static/admin_clubs.js"></script>
`,
  "static/scripts/admin.js": `"use strict";
function _post(url, msg) {
    return fetch(url, { method: "POST" }).then(() => alert(msg));
}
`,
  "static/scripts/admin_clubs.js": `"use strict";

function deleteClub(event) {
    const id = event.target.parentNode.dataset.clubId;
    _post(\`/admin/clubs/\${id}/delete\`, "Club deleted");
}

function relegateClub(event) {
    _post(\`/admin/clubs/\${event.target.dataset.id}/relegate\`, "Club relegated");
}

function promoteClub() {}

function reloadTable() {
    location.reload();
}

function initClubTable() {
    document.querySelectorAll("button[vw-delete-club]").forEach(btn => {
        btn.addEventListener("click", deleteClub);
    });
    for (const btn of document.querySelectorAll("button[vw-relegate-club]")) {
        btn.addEventListener("click", relegateClub);
    }
    document.querySelectorAll('[data-action="promote"]').forEach((b) => b.addEventListener("click", promoteClub));
}

document.addEventListener("DOMContentLoaded", () => {
    initClubTable();
    const reload = document.getElementById("reload-table");
    reload.addEventListener("click", reloadTable);
});
`,
};

describe("page buttons bound by selector from the scripts the page loads", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-dom-bindings-"));
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

  it("links each element to the function its script binds", () => {
    const links = summary.symbolLinks
      .filter((l) => l.sourceFile === "static/templates/admin/clubs.hbs" && l.sourceSymbol === "<component>")
      .map((l) => `${l.sourceLine} ${l.targetSymbol}`)
      .sort();
    // The `for … of` loop variable is not a lookup the script states: relegate stays unbound.
    expect(links).toEqual(["13 reloadTable", "6 deleteClub", "8 promoteClub"]);
  });
});
