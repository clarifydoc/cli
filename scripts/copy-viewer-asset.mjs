// tsdown onSuccess hook: mirrors the committed viewer template into dist/ so the
// bundled html-report.js resolves it via the SAME relative path in both layouts
// (src/core/html-report.ts and dist/index.js both look in ./html-report/viewer-assets/).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "core", "html-report", "viewer-assets", "report-template.html");
const dest = join(root, "dist", "html-report", "viewer-assets", "report-template.html");

if (!existsSync(src)) {
  console.error(`copy-viewer-asset: missing ${src} — run "npm run build:viewer" first`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("copy-viewer-asset: template copied to dist/");
