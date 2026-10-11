import { join, resolve } from "path";
import { execFile } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { gzipSync } from "zlib";
import { buildReportPayload, loadReportSummary, type ReportPayload } from "./report-payload.js";
import { esc } from "./html-report/util.js";

/**
 * Where to read the analysis from and where to put the report.
 * `outputPath` defaults to `report.html` inside the analysis directory;
 * `openBrowser` defaults to true.
 */
export interface ReportOptions {
  analysisDir: string;
  outputPath?: string;
  openBrowser?: boolean;
}

/**
 * Render `report.html` for a finished analysis and refresh `report-data.json`
 * beside it, then open the report in the default browser unless told not to.
 *
 * @param options - Analysis directory, output path and browser flag
 * @returns The path the report was written to
 * @throws When the viewer template is missing (run `npm run build:viewer`)
 */
export async function generateHtmlReport(options: ReportOptions): Promise<string> {
  const dir = resolve(options.analysisDir);
  const summary = await loadReportSummary(dir);
  const payload = buildReportPayload(summary);
  const html = await renderReportFromTemplate(payload);
  const outPath = options.outputPath ?? join(dir, "report.html");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf-8");
  // Keep the viewer data in sync whenever the standalone report is (re)built —
  // e.g. after an `lsp-update` that only touched the summary + enhancement.
  await writeFile(join(dir, "report-data.json"), JSON.stringify(payload), "utf-8");

  if (options.openBrowser !== false) {
    openInBrowser(outPath);
  }
  return outPath;
}

function openInBrowser(filePath: string): void {
  // Argument vectors, never a shell string: the path is passed as-is.
  const [file, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", filePath]] :
    process.platform === "darwin" ? ["open", [filePath]] :
    ["xdg-open", [filePath]];
  execFile(file, args, { windowsHide: true }, () => {}); // fire and forget
}

// ─── Template rendering (the React viewer, packaged as a single file) ────
// The template is the SPA report viewer built by `npm run build:viewer`
// (application/spa/vite.standalone.config.ts → vite-plugin-singlefile), committed
// at src/core/html-report/viewer-assets/ and mirrored into dist/ by tsdown's
// onSuccess hook — the same relative path resolves in both layouts.

const TEMPLATE_URL = new URL("./html-report/viewer-assets/report-template.html", import.meta.url);

/**
 * The payload embeds as gzip+base64 (standalone.tsx inflates it in the browser
 * with the native DecompressionStream). Keeps the multi-MB JSON ~10x smaller on
 * disk AND needs no HTML escaping — base64 contains no `<`, so the payload can
 * never terminate the script tag.
 */
export function encodeReportPayload(payload: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64");
}

function replaceToken(html: string, token: string, value: string): string {
  const count = html.split(token).length - 1;
  if (count !== 1) {
    throw new Error(
      `report template: expected exactly 1 ${token}, found ${count} — rebuild it with "npm run build:viewer"`,
    );
  }
  // Replacer function: passing `value` directly would expand $&, $' and friends
  // if they ever occurred in the replacement text.
  return html.replace(token, () => value);
}

/**
 * Inject a payload into the committed viewer template.
 *
 * The template must contain each placeholder exactly once; the payload goes in
 * gzip+base64 (see `encodeReportPayload`).
 *
 * @param payload - The viewer payload from `buildReportPayload`
 * @returns The self-contained HTML document
 * @throws When the template is missing or a placeholder count is not one
 */
export async function renderReportFromTemplate(payload: ReportPayload): Promise<string> {
  let template: string;
  try {
    template = await readFile(TEMPLATE_URL, "utf-8");
  } catch {
    throw new Error(
      `report viewer template not found at ${TEMPLATE_URL} — run "npm run build:viewer" to build it`,
    );
  }
  const html = replaceToken(template, "__CLARIFYDOC_TITLE__", esc(`ClarifyDoc — ${payload.projectName}`));
  return replaceToken(html, "__CLARIFYDOC_PAYLOAD__", encodeReportPayload(payload));
}
