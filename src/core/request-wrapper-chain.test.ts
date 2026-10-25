import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Classic page scripts calling helpers another script defines, a wrapper of a
 * wrapper of fetch (real-repo FP: 15 admin calls, 0 api-calls).
 */
const FILES: Record<string, string> = {
  "static/assets/admin.js": `"use strict";
const BASE_URL = window.location.origin;

function _fetch(method, url, successMsg, body) {
    fetch(url, { method: method, body: body }).then((resp) => resp.ok && alert(successMsg));
}

function _post(url, successMsg, body) {
    return _fetch("POST", url, successMsg, body);
}

function _delete(url, successMsg) {
    return _fetch("DELETE", url, successMsg);
}
`,
  "static/assets/admin_clubs.js": `"use strict";

function deleteClub(id) {
    _post(\`\${BASE_URL}/admin/clubs/\${id}/delete\`, "Club deleted");
}

function removeCoach(id) {
    _delete(\`\${BASE_URL}/admin/clubs/\${id}/coach\`, "Coach removed");
}
`,
};

describe("a wrapper of a wrapper of a request, in classic scripts", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-wrapper-chain-"));
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

  it("gives each page call its request", () => {
    const calls = (summary.apiCalls ?? []).filter((c) => c.filePath === "static/assets/admin_clubs.js").map((c) => `${c.name} ${c.target}`).sort();
    expect(calls).toEqual(["DELETE /admin/clubs/${id}/coach", "POST /admin/clubs/${id}/delete"]);
  });
});
