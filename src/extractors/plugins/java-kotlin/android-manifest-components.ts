import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { ANDROID_MANIFEST, ANDROID_MANIFEST_FUNCTION, type AndroidManifestFact } from "../shared/android-manifest.js";

/**
 * Components an `AndroidManifest.xml` declares (`<activity android:name=".ui.ClubActivity">`,
 * services, receivers, providers): the platform instantiates them by name, so
 * no code calls them. Each is an edge from the manifest to the class it names —
 * `.ui.ClubActivity` is the manifest's `package` + that path, a name with no
 * dot is directly in the package, and a manifest with no `package` (a Gradle
 * `namespace` instead) names the class by the package that ends with the path.
 * Only a class of the manifest's own module is reached (the directory above
 * its `src/`), so a namesake in another module or package stays unlinked.
 */
export class AndroidManifestComponentsResolver implements DispatchResolver {
  readonly id = "android-manifest";
  readonly languages: Language[] = ["springxml", "java", "kotlin"];
  readonly priority = 12;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const manifests = analyses.filter((a) => a.language === "springxml" && a.routeFacts?.some((f) => f.kind === ANDROID_MANIFEST));
    if (manifests.length === 0) return [];
    const code = analyses.filter((a) => a.language === "java" || a.language === "kotlin");
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const manifest of manifests) {
      const root = moduleRoot(manifest.filePath);
      const inModule = code.filter((c) => c.filePath.startsWith(root));
      for (const fact of manifest.routeFacts!) {
        if (fact.kind !== ANDROID_MANIFEST) continue;
        const data = fact.data as AndroidManifestFact;
        for (const comp of data.components) {
          const target = classOf(comp.name, data.package, inModule);
          if (!target) continue;
          const key = `${manifest.filePath}|${target.file}|${target.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({
            sourceFile: manifest.filePath,
            sourceSymbol: ANDROID_MANIFEST_FUNCTION,
            sourceLine: comp.line,
            callName: `<${comp.tag}> ${comp.name}`,
            targetFile: target.file,
            targetSymbol: target.name,
            targetLine: target.line,
            confidence: "EXTRACTED",
          });
        }
      }
    }
    return links;
  }
}

/** `app/src/main/AndroidManifest.xml` → `app/`; a manifest outside `src/` owns its folder. */
function moduleRoot(path: string): string {
  const i = path.lastIndexOf("/src/");
  if (i >= 0) return path.slice(0, i + 1);
  const j = path.lastIndexOf("/");
  return j >= 0 ? path.slice(0, j + 1) : "";
}

function classOf(written: string, pkg: string | null, code: FileAnalysis[]): { file: string; name: string; line: number } | null {
  let dotted: string;
  if (written.startsWith(".")) dotted = (pkg ?? "") + written;
  else if (!written.includes(".")) dotted = pkg ? `${pkg}.${written}` : written;
  else dotted = written;
  // A nested class (`Sync$Worker`) is no top-level class this resolver can place.
  if (dotted.includes("$")) return null;
  const simple = dotted.slice(dotted.lastIndexOf(".") + 1);
  const owner = dotted.slice(0, Math.max(0, dotted.lastIndexOf(".")));
  const hits: Array<{ file: string; name: string; line: number }> = [];
  for (const a of code) {
    for (const cls of a.classes) {
      if (cls.name !== simple) continue;
      const ns = a.packageName ?? "";
      // The package must be the one written; without a manifest `package`, the one that ends with the written path.
      const exact = pkg !== null || (written.includes(".") && !written.startsWith("."));
      const same = exact ? ns === owner : owner !== "" && (ns === owner || ns.endsWith(owner));
      if (same) hits.push({ file: a.filePath, name: cls.name, line: cls.line });
    }
  }
  return hits.length === 1 ? hits[0]! : null;
}
