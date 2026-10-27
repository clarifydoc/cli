import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec, SelfNameContext } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";
import { withoutXmlComments } from "../shared/xml-scan.js";

/** Maven: `pom.xml` `<dependency>` blocks as `group:artifact`. */
function parsePom(raw: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // What the project depends on: not what a comment shows, a `<dependencyManagement>`
  // pins for its children, or a build plugin needs to run.
  const text = withoutXmlComments(raw)
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/gi, "")
    .replace(/<plugin>[\s\S]*?<\/plugin>/gi, "");
  // `${jackson.version}` from the POM's own `<properties>`.
  const props = new Map<string, string>();
  for (const block of text.matchAll(/<properties>([\s\S]*?)<\/properties>/gi)) {
    for (const p of block[1]!.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(p[1]!, p[2]!);
  }
  const resolve = (v: string): string => v.replace(/\$\{([\w.-]+)\}/g, (all, k: string) => props.get(k) ?? all);
  const re = /<dependency>([\s\S]*?)<\/dependency>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1]!;
    const group = body.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/i)?.[1];
    const artifact = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/i)?.[1];
    const written = body.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1];
    const version = written ? resolve(written) : null;
    const scope = /test/i.test(body.match(/<scope>\s*([^<]+?)\s*<\/scope>/i)?.[1] ?? "") ? "dev" : "prod";
    if (!artifact) continue;
    const name = group ? `${group}:${artifact}` : artifact;
    out.push(declared(name, version, "maven", scope, declaredIn));
  }
  return out;
}

/** The dependency configurations a Gradle build declares packages under. */
const CONFIG = String.raw`\b(\w*[iI]mplementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|testCompileOnly|kapt|ksp|annotationProcessor|developmentOnly|coreLibraryDesugaring)`;
const STRING_COORD_RE = new RegExp(String.raw`${CONFIG}\s*\(?\s*(?:(?:platform|enforcedPlatform)\s*\(\s*)?['"]([^'"]+:[^'"]+)['"]`, "g");
/** `implementation group: 'g', name: 'a', version: 'v'` (Groovy) / `implementation(group = "g", name = "a", version = "v")` (Kotlin). */
const MAP_COORD_RE = new RegExp(String.raw`${CONFIG}\s*\(?\s*group\s*[:=]\s*['"]([^'"]+)['"]\s*,\s*name\s*[:=]\s*['"]([^'"]+)['"](?:\s*,\s*version\s*[:=]\s*['"]([^'"]+)['"])?`, "g");
/** `implementation(kotlin("reflect"))`, `kotlin("stdlib", "1.9.20")`. */
const KOTLIN_COORD_RE = new RegExp(String.raw`${CONFIG}\s*\(\s*kotlin\s*\(\s*['"]([\w-]+)['"](?:\s*,\s*['"]([^'"]+)['"])?\s*\)`, "g");
/** `implementation(libs.androidx.core.ktx)`, `implementation(platform(libs.compose.bom))`, `implementation(libs.bundles.ktor)`. */
const CATALOG_REF_RE = new RegExp(String.raw`${CONFIG}\s*\(?\s*(?:(?:platform|enforcedPlatform)\s*\(\s*)?libs\.([\w.]+)`, "g");

/** A version catalog (`gradle/libs.versions.toml`): libraries and bundles by their accessor key. */
interface VersionCatalog {
  libraries: Map<string, { name: string; version: string | null }>;
  bundles: Map<string, string[]>;
}

/** The accessor an alias is written as: `androidx-core_ktx` → `androidx.core.ktx`. */
const accessor = (alias: string): string => alias.toLowerCase().replace(/[-_]/g, ".");

/** The `[versions]`, `[libraries]` and `[bundles]` tables of a catalog, one entry per line (bundles may span lines). */
export function parseVersionCatalog(toml: string): VersionCatalog {
  const versions = new Map<string, string>();
  const raw: Array<[string, string]> = [];
  const bundles = new Map<string, string[]>();
  let section = "";
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const head = /^\[([\w-]+)\]$/.exec(line);
    if (head) { section = head[1]!; continue; }
    const kv = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!;
    if (section === "bundles" && value.startsWith("[") && !value.includes("]")) {
      while (++i < lines.length && !value.includes("]")) value += lines[i]!.replace(/\s+#.*$/, "");
    }
    if (section === "versions") {
      const v = /^["']([^"']+)["']/.exec(value)?.[1] ?? /\b(?:strictly|require|prefer)\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
      if (v) versions.set(kv[1]!, v);
    } else if (section === "libraries") raw.push([kv[1]!, value]);
    else if (section === "bundles") bundles.set(accessor(kv[1]!), [...value.matchAll(/["']([^"']+)["']/g)].map((m) => accessor(m[1]!)));
  }
  const libraries = new Map<string, { name: string; version: string | null }>();
  for (const [alias, value] of raw) {
    const str = (key: string) => new RegExp(String.raw`\b${key}\s*=\s*["']([^"']+)["']`).exec(value)?.[1];
    let name: string | undefined;
    let version: string | null = null;
    const plain = /^["']([^"':]+:[^"':]+)(?::([^"']+))?["']$/.exec(value);
    if (plain) { name = plain[1]; version = plain[2] ?? null; }
    else {
      const module = str("module");
      const group = str("group");
      const artifact = str("name");
      name = module ?? (group && artifact ? `${group}:${artifact}` : undefined);
      const ref = /\bversion\.ref\s*=\s*["']([^"']+)["']/.exec(value)?.[1] ?? /\bversion\s*=\s*\{[^}]*\bref\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
      version = ref ? versions.get(ref) ?? null : /\bversion\s*=\s*["']([^"']+)["']/.exec(value)?.[1] ?? null;
    }
    if (name) libraries.set(accessor(alias), { name, version });
  }
  return { libraries, bundles };
}

/** String values a build script or `gradle.properties` names: `val ktorVersion = "2.3.0"`, `ext.kotlin_version = '1.9'`, `ktor_version=2.3.0`. */
function scriptValues(text: string, properties: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (properties ?? "").split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*[=:]\s*([^\s#]+)\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  for (const m of text.matchAll(/(?:\b(?:val|var|def)\s+|\bext\.|^\s*(?:set\s*\(\s*)?|\bextra\[\s*["'])(\w+)["']?\s*\]?\s*[=,]\s*["']([^"'$]+)["']/gm)) out.set(m[1]!, m[2]!);
  return out;
}

/**
 * Gradle: what each dependency configuration declares — `"group:artifact:version"`
 * (a `$version` from the script or gradle.properties filled in), the
 * `group:/name:/version:` map form, `kotlin("x")`, and version-catalog
 * accessors (`libs.androidx.core.ktx`, `libs.bundles.ktor`) read from the catalog.
 */
export function parseGradle(text: string, declaredIn: string, catalog: VersionCatalog | null = null, properties: string | null = null): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const values = text.includes("$") ? scriptValues(text, properties) : new Map<string, string>();
  const fill = (v: string | undefined): string | null => {
    if (!v) return null;
    const filled = v.replace(/\$\{?([\w.]+)\}?/g, (all, k: string) => values.get(k) ?? values.get(k.replace(/^(?:project|rootProject)\./, "")) ?? all);
    return filled.includes("$") ? null : filled;
  };
  const scopeOf = (config: string): PackageScope => (/^test/i.test(config) ? "dev" : "prod");
  for (const m of text.matchAll(STRING_COORD_RE)) {
    const parts = m[2]!.split(":");
    if (parts.length < 2) continue;
    out.push(declared(`${parts[0]}:${parts[1]}`, fill(parts[2]), "gradle", scopeOf(m[1]!), declaredIn));
  }
  for (const m of text.matchAll(MAP_COORD_RE)) out.push(declared(`${m[2]}:${m[3]}`, fill(m[4]), "gradle", scopeOf(m[1]!), declaredIn));
  for (const m of text.matchAll(KOTLIN_COORD_RE)) out.push(declared(`org.jetbrains.kotlin:kotlin-${m[2]}`, fill(m[3]), "gradle", scopeOf(m[1]!), declaredIn));
  if (catalog) {
    for (const m of text.matchAll(CATALOG_REF_RE)) {
      const key = m[2]!.replace(/\.get$/, "").toLowerCase();
      const bundle = key.startsWith("bundles.") ? catalog.bundles.get(key.slice("bundles.".length)) : undefined;
      for (const lib of bundle ?? [key]) {
        const hit = catalog.libraries.get(lib);
        if (hit) out.push(declared(hit.name, hit.version, "gradle", scopeOf(m[1]!), declaredIn));
      }
    }
  }
  return out;
}

/** The sections of a POM whose `<groupId>`/`<artifactId>` are another project's, not its own. */
const FOREIGN_POM_SECTIONS = /<(parent|dependencies|dependencyManagement|build|reporting|profiles|distributionManagement|pluginRepositories|repositories|exclusions)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * The coordinates a POM publishes, `groupId:artifactId`: its own `<groupId>`,
 * else the one its `<parent>` names (Maven's inheritance); a `${...}` value
 * filled from the POM's `<properties>` or the parent's, else no name.
 */
export function pomSelfName(raw: string): string | null {
  const text = withoutXmlComments(raw);
  const own = text.replace(FOREIGN_POM_SECTIONS, "");
  const parent = /<parent>([\s\S]*?)<\/parent>/i.exec(text)?.[1] ?? "";
  const tag = (body: string, name: string) => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i").exec(body)?.[1];
  const props = new Map<string, string>();
  for (const block of own.matchAll(/<properties>([\s\S]*?)<\/properties>/gi)) {
    for (const p of block[1]!.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(p[1]!, p[2]!);
  }
  const parentGroup = tag(parent, "groupId");
  if (parentGroup) props.set("project.parent.groupId", parentGroup).set("parent.groupId", parentGroup);
  const fill = (v: string | undefined) => {
    const filled = v?.replace(/\$\{([\w.-]+)\}/g, (all, k: string) => props.get(k) ?? all);
    return filled && !filled.includes("${") ? filled : null;
  };
  const artifact = fill(tag(own.replace(/<properties>[\s\S]*?<\/properties>/gi, ""), "artifactId"));
  const group = fill(tag(own.replace(/<properties>[\s\S]*?<\/properties>/gi, ""), "groupId") ?? parentGroup);
  return artifact && group ? `${group}:${artifact}` : null;
}

// A Java/Kotlin import names a package, never an artifact: usage stays unknown.
export const mavenPackageManager: PackageManagerSpec = {
  ecosystem: "maven",
  manifests: [{ files: ["pom.xml"], parse: (text, file) => parsePom(text, file.declaredIn), selfName: pomSelfName }],
};

/** `group = "x"` / `group 'x'` / `group.set("x")`, and the like for another property. */
const assigned = (name: string) => new RegExp(String.raw`(?:^|[{;])\s*(?:project\.)?${name}(?:\s*=\s*|\s+|\.set\s*\(\s*)["']([^"'$]+)["']`, "m");

/** The `name { … }` blocks of a build script, braces balanced: where each body starts and ends. */
function blockSpans(text: string, name: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(new RegExp(String.raw`(?:^|[\s;])${name}\s*(?:\(\s*\))?\s*\{`, "g"))) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    out.push({ start, end: i - 1 });
  }
  return out;
}

const blockBodies = (text: string, name: string): string[] => blockSpans(text, name).map((s) => text.slice(s.start, s.end));

/** The script without the bodies of `names` blocks (a `subprojects` group is its children's, a dependency's `group =` another package's). */
function withoutBlocks(text: string, names: readonly string[]): string {
  const spans = names.flatMap((n) => blockSpans(text, n));
  const outer = spans.filter((s) => !spans.some((o) => o !== s && o.start <= s.start && s.end <= o.end)).sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of outer) out = out.slice(0, span.start) + out.slice(span.end);
  return out;
}

/**
 * The coordinates a Gradle build publishes, `group:name`: the artifact is a
 * `maven-publish` publication's `artifactId`, else `base.archivesName` /
 * `archivesBaseName`, else the project's name — `rootProject.name` in the
 * settings beside it, else (below the analysis root) its directory's. The group
 * is its own `group`, else one an enclosing build sets for it in
 * `allprojects`/`subprojects`, else `group=` in a `gradle.properties`.
 */
export async function gradleSelfName(text: string, file: SelfNameContext): Promise<string | null> {
  const value = (body: string, name: string) => assigned(name).exec(body)?.[1] ?? null;
  const publication = blockBodies(text, "publishing").join("\n");
  let artifact = value(publication, "artifactId")
    ?? value(text, "archivesBaseName")
    ?? value(text, "base\\.archivesName")
    ?? blockBodies(text, "base").map((b) => value(b, "archivesName")).find(Boolean)
    ?? null;
  if (!artifact) {
    const settings = (await file.readSibling("settings.gradle.kts")) ?? (await file.readSibling("settings.gradle"));
    artifact = (settings ? value(settings, "rootProject\\.name") : null) ?? file.dirName;
  }
  let group = value(publication, "groupId") ?? value(withoutBlocks(text, ["subprojects", "dependencies", "publishing"]), "group");
  if (!group) {
    for (const build of [...await file.readAncestors("build.gradle.kts"), ...await file.readAncestors("build.gradle")]) {
      group = [...blockBodies(build, "allprojects"), ...blockBodies(build, "subprojects")].map((b) => value(b, "group")).find(Boolean) ?? null;
      if (group) break;
    }
  }
  if (!group) {
    const properties = [(await file.readSibling("gradle.properties")) ?? "", ...await file.readAncestors("gradle.properties")];
    group = properties.map((p) => /^\s*group\s*[=:]\s*(\S+)\s*$/m.exec(p)?.[1]).find(Boolean) ?? null;
  }
  return artifact && group ? `${group}:${artifact}` : null;
}

export const gradlePackageManager: PackageManagerSpec = {
  ecosystem: "gradle",
  // Gradle resolves from Maven repositories: its coordinates are Maven's.
  registry: "maven",
  manifests: [
    {
      files: ["build.gradle.kts", "build.gradle"],
      firstOnly: true,
      selfName: gradleSelfName,
      parse: async (text, file) => {
        const toml = /\blibs\./.test(text) ? await file.readAbove?.("gradle/libs.versions.toml") : null;
        const properties = text.includes("$") ? (await file.readAbove?.("gradle.properties")) ?? null : null;
        return parseGradle(text, file.declaredIn, toml ? parseVersionCatalog(toml) : null, properties);
      },
    },
  ],
};
