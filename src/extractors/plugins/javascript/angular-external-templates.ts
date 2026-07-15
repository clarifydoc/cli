import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import type { FileAnalysis } from "../../../types/analysis.js";
import {
  extractAngularComponentTreeFromTemplate,
  extractAngularInteractiveElementsFromTemplate,
} from "./angular-template.js";

/**
 * Resolve Angular components' EXTERNAL templates (`templateUrl: './x.html'`).
 *
 * The per-file pass reads files individually, so a component that keeps its
 * markup in a sibling .html contributes NO interactive elements or component
 * tree — its whole screen/interaction layer is invisible, and external
 * templates are the dominant Angular style. This project-level pass runs after
 * per-file analysis (mirroring `detectFileBasedRoutes`): for each component
 * that recorded an `angularTemplateUrl`, it reads the sibling .html, runs the
 * Angular-dialect template extraction, and back-fills the component's
 * `interactiveElements`/`templateTree` so the screen builder and the
 * button→handler→service→API chain work exactly as they do for inline
 * templates. In-memory only (no per-file JSON changes).
 *
 * Returns the number of components enriched. Mutates `analyses` in place.
 */
export async function resolveAngularExternalTemplates(
  analyses: FileAnalysis[],
  projectRoot: string,
): Promise<number> {
  // Absolute-path index so a resolved templateUrl can find the sibling .html's
  // own analysis (the HTML plugin analyzed it independently).
  const byAbs = new Map<string, FileAnalysis>();
  for (const a of analyses) byAbs.set(resolve(projectRoot, a.filePath), a);

  let enriched = 0;
  for (const a of analyses) {
    const url = a.angularTemplateUrl;
    if (!url) continue;
    // An inline template already populated these — don't double up.
    if ((a.interactiveElements?.length ?? 0) > 0 || (a.templateTree?.length ?? 0) > 0) continue;

    const htmlPath = resolve(projectRoot, dirname(a.filePath), url);
    let text: string;
    try {
      text = await readFile(htmlPath, "utf-8");
    } catch {
      continue; // template moved/renamed — leave the component un-enriched
    }

    const interactive = extractAngularInteractiveElementsFromTemplate(text);
    const tree = extractAngularComponentTreeFromTemplate(text);
    if (interactive.length === 0 && tree.length === 0) continue;
    if (interactive.length > 0) a.interactiveElements = interactive;
    if (tree.length > 0) a.templateTree = tree;
    enriched++;

    // The sibling .html is an Angular component template PARTIAL, not a
    // standalone page — the HTML plugin gave it a `kind:"frontend"` route by
    // its file path. Drop that phantom page route so an Angular app's component
    // templates don't each surface as a bogus screen (the real screen is the
    // component this partial belongs to).
    const htmlAnalysis = byAbs.get(htmlPath);
    if (htmlAnalysis && htmlAnalysis !== a) {
      const kept = (htmlAnalysis.routes ?? []).filter((r) => r.kind !== "frontend");
      if (kept.length !== (htmlAnalysis.routes?.length ?? 0)) htmlAnalysis.routes = kept;
    }
  }
  return enriched;
}
