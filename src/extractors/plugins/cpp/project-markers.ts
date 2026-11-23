import type { ProjectMarkerContext } from "../../../types/language-plugin.js";

/**
 * Only a CMakeLists.txt containing a `project()` call marks a project root: most are per-directory source
 * lists (`add_subdirectory` targets), and treating them as markers would fragment the repository under innermost-wins.
 */
export async function declaresCmakeProject(file: ProjectMarkerContext): Promise<boolean> {
  try {
    return /^\s*project\s*\(/im.test(await file.text());
  } catch {
    return false;
  }
}
