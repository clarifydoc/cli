import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A CodeIgniter action renders a plain-PHP view by its path (real-repo FP: 17 of 375 views had a route). */
const FILES: Record<string, string> = {
  "application/controllers/garage.php": `<?php
class Garage extends CI_Controller {
  public function index() {
    $data['cars'] = $this->db->get('cars')->result();
    $this->load->view('garage/list', $data);
  }
}
`,
  "application/views/garage/list.php": `<h1>Garage</h1>
<form method="post" action="<?=base_url();?>garage/save"><input name="plate"><button type="submit">Save</button></form>
`,
};

describe("CodeIgniter views rendered by path", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ci-render-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives the view the route of the action that loads it", () => {
    expect((summary.screens ?? []).find((s) => s.filePath === "application/views/garage/list.php")?.routePath).toBe("/garage");
  });
});
