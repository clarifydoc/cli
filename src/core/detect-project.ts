import { resolve } from "path";
import { detectFrameworksAcrossRoots, gatherProjectInfo } from "./framework-detector.js";
import { detectSubProjects } from "./project-detector.js";
import { EXTENSION_TO_LANGUAGE, NAMED_FILE_LANGUAGE } from "../extractors/registry.js";

/**
 * What discovery picks up — the same tables it globs by — so a caller that
 * watches for changes (the VS Code extension) never keeps its own list.
 */
export function analyzableFiles(): { analyzableExtensions: string[]; namedFiles: string[] } {
  return {
    analyzableExtensions: Object.keys(EXTENSION_TO_LANGUAGE).sort(),
    namedFiles: [...NAMED_FILE_LANGUAGE.keys()].sort(),
  };
}

/**
 * `clarifydoc detect`: a project's file extensions and frameworks, read now,
 * without an analysis. Frameworks are detected across the root AND every
 * sub-project root — build manifests in a monorepo (a Flutter `pubspec.yaml`,
 * a nested `package.json`/`pom.xml`) live below the root, so a root-only scan
 * misses them. This mirrors what `analyze` records in `detectedFrameworks`.
 */
export async function detectProject(path: string): Promise<{
  root: string;
  fileExtensions: string[];
  frameworks: Array<{ name: string; detectedVia: string }>;
  analyzableExtensions: string[];
  namedFiles: string[];
}> {
  const root = resolve(path);
  const info = await gatherProjectInfo(root);
  const subProjects = await detectSubProjects(root);
  const { merged } = await detectFrameworksAcrossRoots(root, subProjects.map((s) => s.root));
  return {
    root,
    fileExtensions: [...info.fileExtensions].sort(),
    frameworks: merged.map((fw) => ({ name: fw.name, detectedVia: fw.detectedVia })),
    ...analyzableFiles(),
  };
}
