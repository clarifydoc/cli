import type { RouteFact } from "../../../types/analysis.js";

/**
 * An `AndroidManifest.xml`: the components the platform instantiates by NAME
 * (`<activity android:name=".ui.ClubActivity">`, services, receivers,
 * providers) — nothing in code calls them. `.xml` belongs to the springxml
 * plugin, which states the manifest as one `routeFact` and a `<manifest>`
 * function to anchor the edge at; the Java/Kotlin dispatch resolver
 * (`java-kotlin/android-manifest-components.ts`) joins it to the classes.
 */
export const ANDROID_MANIFEST = "android-manifest";
export const ANDROID_MANIFEST_FUNCTION = "<manifest>";

export interface AndroidManifestFact {
  /** The manifest's `package` attribute (modern Gradle projects declare a `namespace` instead: null). */
  package: string | null;
  components: Array<{ tag: string; name: string; line: number }>;
}

const COMPONENT_TAGS = ["activity", "activity-alias", "service", "receiver", "provider", "application"];
const TAG_RE = /<([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)\/?>/g;
const ATTR_RE = /\bandroid:(name|targetActivity)\s*=\s*"([^"]*)"/g;

/** True for a manifest: a `<manifest>` root in the Android namespace. */
export function isAndroidManifest(raw: string): boolean {
  return /<manifest[\s>]/.test(raw) && raw.includes("schemas.android.com/apk/res");
}

export function androidManifestFacts(lines: string[], facts: RouteFact[]): void {
  const text = lines.join("\n").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  if (!isAndroidManifest(text)) return;
  const fact: AndroidManifestFact = { package: /<manifest\b[^>]*?\bpackage\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null, components: [] };
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1]!;
    if (!COMPONENT_TAGS.includes(tag)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    for (const a of m[2]!.matchAll(ATTR_RE)) fact.components.push({ tag, name: a[2]!, line });
  }
  if (fact.components.length) facts.push({ kind: ANDROID_MANIFEST, line: 1, data: fact });
}
