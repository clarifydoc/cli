/**
 * A screen navigates where the components it builds navigate, across files.
 *
 * A plugin reports each file's UI components (`FileAnalysis.uiComponents`):
 * what each builds by name from other files and where it navigates, the
 * components of its own file already folded in. This pass starts at every
 * screen's own component row and follows the names it builds to the one
 * component another file declares under that name, a bounded number of files
 * deep, adding what each navigates to the screen's `navigatesTo`. It never
 * goes through another screen: a shell that builds its tab pages does not
 * offer their links.
 *
 * A name resolves to the declaring file the builder imports when exactly one
 * does, else to the one declaration in the builder's sub-project, else to
 * nothing — two widgets of one name are never guessed between. Production
 * code never resolves into a test file. What a component builds as a
 * parameter's default (`UiComponentInfo.defaults`) is followed only from a
 * builder that leaves the parameter out (`passes`); a screen is built by its
 * router, which passes none.
 */
import type { FileAnalysis, UiComponentInfo } from "../types/analysis.js";
import { isTestFile } from "./test-file-detector.js";

/** How many files deep a screen's components are followed. */
const MAX_DEPTH = 4;

interface Declared {
  file: string;
  project: string | undefined;
  test: boolean;
  component: UiComponentInfo;
}

/**
 * Add to each screen the navigation of the components of other files it builds.
 *
 * @param analyses - Every file analysis; screens are updated in place
 * @param importGraph - File → the project files it imports (the component graph)
 * @returns How many navigation edges were added
 */
export function composeScreenNavigation(analyses: FileAnalysis[], importGraph: Record<string, string[]>): number {
  const declaring = new Map<string, Declared[]>();
  const screensIn = new Map<string, Set<string>>();
  const testFile = new Map<string, boolean>();
  for (const a of analyses) {
    if (!a.uiComponents?.length) continue;
    const test = isTestFile(a.filePath, a.language);
    testFile.set(a.filePath, test);
    for (const component of a.uiComponents) {
      const list = declaring.get(component.name) ?? [];
      list.push({ file: a.filePath, project: a.projectId, test, component });
      declaring.set(component.name, list);
    }
    if (a.screens.length > 0) screensIn.set(a.filePath, new Set(a.screens.map((s) => s.name)));
  }
  if (declaring.size === 0) return 0;

  const resolve = (name: string, fromFile: string, project: string | undefined): Declared | null => {
    let candidates = (declaring.get(name) ?? []).filter((d) => d.file !== fromFile);
    if (!testFile.get(fromFile)) candidates = candidates.filter((d) => !d.test);
    if (candidates.length === 0) return null;
    const imported = new Set(importGraph[fromFile] ?? []);
    const viaImport = candidates.filter((d) => imported.has(d.file));
    if (viaImport.length > 0) return viaImport.length === 1 ? viaImport[0]! : null;
    const sameProject = candidates.filter((d) => d.project === project);
    return sameProject.length === 1 ? sameProject[0]! : null;
  };

  /** What a component builds when its builder passes `passed` (null: unknown, so every default is built). */
  const builtBy = (component: UiComponentInfo, passed: readonly string[] | null): string[] => {
    const names = [...component.builds];
    for (const [param, defaults] of Object.entries(component.defaults ?? {})) {
      if (!passed?.includes(param)) names.push(...defaults);
    }
    return names;
  };

  let added = 0;
  for (const a of analyses) {
    if (!a.uiComponents?.length || a.screens.length === 0) continue;
    for (const screen of a.screens) {
      const own = a.uiComponents.find((c) => c.name === screen.name);
      if (!own) continue;
      const targets = new Set(screen.navigatesTo);
      const seen = new Set<string>([`${a.filePath}#${screen.name}`]);
      let frontier: Array<{ file: string; project: string | undefined; component: UiComponentInfo; passed: readonly string[] | null }> =
        [{ file: a.filePath, project: a.projectId, component: own, passed: null }];
      for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
        const next: typeof frontier = [];
        for (const from of frontier) {
          for (const name of builtBy(from.component, from.passed)) {
            const d = resolve(name, from.file, from.project);
            if (!d || screensIn.get(d.file)?.has(name)) continue;
            const key = `${d.file}#${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            for (const t of d.component.navigatesTo) {
              if (t === screen.name || targets.has(t)) continue;
              targets.add(t);
              screen.navigatesTo.push(t);
              added++;
            }
            next.push({ file: d.file, project: d.project, component: d.component, passed: from.component.passes?.[name] ?? [] });
          }
        }
        frontier = next;
      }
    }
  }
  return added;
}
