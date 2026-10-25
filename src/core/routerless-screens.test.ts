import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * A webview app with no router (real-repo FP): every component used to be a screen — a legend, an
 * overlay, a node renderer — and diagram pages under docs/ were routes. The screens are what the
 * app shows on its own: what the entry mounts, and what nothing imports.
 */
describe("screens of a router-less app", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-routerless-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"garage-view","dependencies":{"react":"18.0.0"}}');
    await file("src/index.tsx", 'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n');
    await file("src/App.tsx", 'import CarLegend from "./CarLegend";\nimport { CarNode } from "./CarNode";\nconst nodeTypes = { car: CarNode };\nexport default function App() {\n  return <div><input value="" onChange={() => {}} /><CarLegend /></div>;\n}\n');
    await file("src/CarLegend.tsx", 'export default function CarLegend() {\n  return <ul><li><button onClick={() => {}}>Hide</button></li></ul>;\n}\n');
    await file("src/CarNode.tsx", 'export function CarNode() {\n  return <div><input type="checkbox" /></div>;\n}\n');
    await file("docs/architecture/flows.html", '<html><head><title>Flows</title></head><body><svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg><button onclick="downloadPNG()">PNG</button></body></html>\n');
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the mounted root and drops its parts and the diagram page", async () => {
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    expect((summary.screens ?? []).map((s) => s.filePath).sort()).toEqual(["src/App.tsx"]);
    expect((summary.routeMap ?? []).filter((r) => r.kind === "frontend")).toEqual([]);
  });
});
