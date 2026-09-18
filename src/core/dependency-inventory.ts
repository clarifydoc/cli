import { readFile } from "fs/promises";
import { byOrdinal } from "./ordinal.js";
import { resolve, join } from "path";
import fg from "fast-glob";
import type {
  ExternalPackage,
  PackageEcosystem,
  PackageScope,
  FrameworkDetection,
  FileAnalysis,
  Language,
} from "../types/analysis.js";
import { classifyKnownPackage, type KnownPackageEntry } from "../extractors/registry.js";

/**
 * Project-wide third-party dependency inventory.
 *
 * Where `framework-detector.ts` answers "is framework X present?" from a fixed
 * allowlist, this module answers the broader question: *what is the
 * full external surface of this codebase, and how much of it is actually live?*
 * It (1) parses every manifest ecosystem for declared dependencies, (2) buckets
 * each into a functional category, (3) cross-references the declarations against
 * the imports in analyzed source to mark used/unused, and (4) derives framework
 * detections from the packages it recognises — so adding a framework is often
 * just adding a row to the classification table below.
 *
 * Everything here is project-level (it never touches per-file `FileAnalysis`
 * output), so changes do not require an `EXTRACTOR_VERSION` bump.
 */

// ─── Classification ───────────────────────────────────────────────────────
// The core holds NO hardcoded package names: each language plugin contributes
// its ecosystem's packages via `meta.knownPackages`, aggregated by the registry
// into `classifyKnownPackage`. Only ecosystem-agnostic name-shape heuristics
// (the long tail: `@types/*`, `*-eslint`, bundler/test names) live here.

/**
 * Categorise a package: plugin-contributed exact hit first (also tried on the
 * trailing coordinate segment so `gorm.io/gorm` / `group:artifact` resolve),
 * then generic name-shape heuristics, else "other". Carries the framework too.
 */
function classify(name: string): KnownPackageEntry {
  const lower = name.toLowerCase();
  // `@types/*` are TypeScript stubs — never the framework they shadow
  // (`@types/express` must not become "express"/framework). Check before the
  // segment fallback below, which would otherwise split off the tail name.
  if (lower.startsWith("@types/")) return { category: "types" };

  const direct = classifyKnownPackage(lower);
  if (direct) return direct;

  // Try the trailing coordinate segment (Maven group:artifact, Go host/path,
  // dotted namespace). Skip npm `@scope/pkg` — its tail is a short name that
  // spuriously collides with unrelated packages.
  if (!lower.startsWith("@")) {
    const seg = lower.split(/[/:]/).pop();
    if (seg && seg !== lower) {
      const bySeg = classifyKnownPackage(seg);
      if (bySeg) return bySeg;
    }
  }

  // Generic name-shape heuristics for the long tail.
  if (lower.endsWith("-types") || lower.startsWith("types-")) return { category: "types" };
  if (/(^|[-_./])eslint|prettier|stylelint|tslint|rubocop|(^|[-_])lint($|[-_])/.test(lower)) return { category: "lint" };
  if (/(^|[-_./])(webpack|rollup|vite|esbuild|babel|parcel|gulp|grunt|swc)($|[-_./])/.test(lower)) return { category: "build" };
  if (/(^|[-_./])(test|tests|jest|vitest|mocha|jasmine|cypress|pytest|junit|spec|mock)($|[-_./])/.test(lower)) return { category: "testing" };
  if (/(^|[-_./])(orm|sequelize|hibernate|sqlalchemy)($|[-_./])/.test(lower)) return { category: "orm" };
  if (/(^|[-_./])(logger|logging)($|[-_./])/.test(lower)) return { category: "logging" };
  return { category: "other" };
}

// ─── Manifest parsers ──────────────────────────────────────────────────────
// Each returns *declared* packages (name/version/scope/ecosystem/declaredIn);
// category is filled by `classify` afterwards. Parsers are deliberately
// line/regex-oriented (matching the repo's existing manifest handling) rather
// than pulling full TOML/XML parser deps.

type RawPkg = Omit<ExternalPackage, "category">;

function mk(
  name: string,
  version: string | null,
  ecosystem: PackageEcosystem,
  scope: PackageScope,
  declaredIn: string,
): RawPkg {
  return { name, version, ecosystem, scope, declaredIn };
}

function parseNpm(text: string, declaredIn: string): RawPkg[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const out: RawPkg[] = [];
  const sections: Array<[string, PackageScope]> = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
    ["optionalDependencies", "optional"],
  ];
  for (const [key, scope] of sections) {
    const deps = json[key] as Record<string, string> | undefined;
    if (!deps || typeof deps !== "object") continue;
    for (const [name, version] of Object.entries(deps)) {
      out.push(mk(name, typeof version === "string" ? version : null, "npm", scope, declaredIn));
    }
  }
  return out;
}

function parseComposer(text: string, declaredIn: string): RawPkg[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const out: RawPkg[] = [];
  for (const [key, scope] of [["require", "prod"], ["require-dev", "dev"]] as Array<[string, PackageScope]>) {
    const deps = json[key] as Record<string, string> | undefined;
    if (!deps || typeof deps !== "object") continue;
    for (const [name, version] of Object.entries(deps)) {
      // Skip platform requirements (php itself, ext-*, lib-*) — not packages.
      if (name === "php" || /^(ext|lib)-/.test(name)) continue;
      out.push(mk(name, typeof version === "string" ? version : null, "composer", scope, declaredIn));
    }
  }
  return out;
}

function parseCsproj(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  // <PackageReference Include="X" Version="Y" /> (Version may also be a child element or absent under CPM).
  const re = /<PackageReference\s+(?:Include|Update)\s*=\s*"([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const attrs = m[2] ?? "";
    const body = m[3] ?? "";
    const vAttr = attrs.match(/Version\s*=\s*"([^"]+)"/i);
    const vChild = body.match(/<Version>\s*([^<]+?)\s*<\/Version>/i);
    out.push(mk(name, vAttr?.[1] ?? vChild?.[1] ?? null, "nuget", "prod", declaredIn));
  }
  // packages.config: <package id="X" version="Y" />
  const pc = /<package\s+id\s*=\s*"([^"]+)"(?:[^>]*?version\s*=\s*"([^"]+)")?/gi;
  while ((m = pc.exec(text)) !== null) {
    out.push(mk(m[1], m[2] ?? null, "nuget", "prod", declaredIn));
  }
  return out;
}

function parsePom(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const re = /<dependency>([\s\S]*?)<\/dependency>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    const group = body.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/i)?.[1];
    const artifact = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/i)?.[1];
    const version = body.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1] ?? null;
    const scope = /test/i.test(body.match(/<scope>\s*([^<]+?)\s*<\/scope>/i)?.[1] ?? "") ? "dev" : "prod";
    if (!artifact) continue;
    const name = group ? `${group}:${artifact}` : artifact;
    out.push(mk(name, version, "maven", scope, declaredIn));
  }
  return out;
}

function parseGradle(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  // implementation "group:artifact:version" / api('group:artifact:version') / testImplementation ...
  const re = /\b(\w*[iI]mplementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|annotationProcessor|developmentOnly)\s*[("']\s*['"]([^'"]+:[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const config = m[1];
    const coord = m[2]; // group:artifact[:version]
    const parts = coord.split(":");
    if (parts.length < 2) continue;
    const name = `${parts[0]}:${parts[1]}`;
    const version = parts[2] ?? null;
    const scope: PackageScope = /^test/i.test(config) ? "dev" : "prod";
    out.push(mk(name, version, "gradle", scope, declaredIn));
  }
  return out;
}

function parseGoMod(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  // require ( <path> <version> [// indirect] ) blocks and single-line requires.
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("require (")) { inBlock = true; continue; }
    if (inBlock && line === ")") { inBlock = false; continue; }
    let body = line;
    if (!inBlock) {
      const single = line.match(/^require\s+(.+)$/);
      if (!single) continue;
      body = single[1];
    }
    if (!body || body.startsWith("//")) continue;
    const parts = body.replace(/\/\/.*$/, "").trim().split(/\s+/);
    if (parts.length < 2) continue;
    out.push(mk(parts[0], parts[1], "go", "prod", declaredIn));
  }
  return out;
}

function parseCargo(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const lines = text.split(/\r?\n/);
  let scope: PackageScope | null = null;
  // A `[dependencies.foo]` table declares the package across several lines;
  // hold it open until the next section (or EOF) so its `version = "…"` is read.
  let pending: { name: string; scope: PackageScope; version: string | null } | null = null;
  const flush = () => { if (pending) { out.push(mk(pending.name, pending.version, "cargo", pending.scope, declaredIn)); pending = null; } };

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      flush();
      const s = section[1].trim();
      const table = s.match(/^(dev-|build-)?dependencies\.(.+)$/);
      if (table) {
        scope = null; // inside a table block, not a flat list
        pending = { name: table[2], scope: table[1] ? "dev" : "prod", version: null };
      } else if (s === "dependencies" || s.endsWith(".dependencies")) scope = "prod";
      else if (s === "dev-dependencies" || s.endsWith(".dev-dependencies")) scope = "dev";
      else if (s === "build-dependencies" || s.endsWith(".build-dependencies")) scope = "dev";
      else scope = null;
      continue;
    }
    if (pending) {
      const v = line.match(/^version\s*=\s*"([^"]+)"/);
      if (v) pending.version = v[1];
      continue;
    }
    if (!scope) continue;
    // name = "1.2" | name = { version = "1.2", ... }
    const dep = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!dep) continue;
    const rhs = dep[2];
    const version = rhs.match(/^"([^"]+)"/)?.[1] ?? rhs.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? null;
    out.push(mk(dep[1], version, "cargo", scope, declaredIn));
  }
  flush();
  return out;
}

function parseGemfile(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const lines = text.split(/\r?\n/);
  const groupStack: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    const groupOpen = line.match(/^group\s+(.+?)\s+do$/);
    if (groupOpen) { groupStack.push(groupOpen[1]); continue; }
    if (line === "end" && groupStack.length) { groupStack.pop(); continue; }
    const gem = line.match(/^gem\s+['"]([^'"]+)['"]/);
    if (!gem) continue;
    // Positional args after the name are version constraints ('~> 7.0', '>= 6', '< 8');
    // they end at the first keyword option (require:, github:, branch: …), whose
    // quoted *values* must not be mistaken for constraints.
    const constraints: string[] = [];
    let rest = line.slice(gem[0].length);
    let arg: RegExpMatchArray | null;
    while ((arg = rest.match(/^\s*,\s*['"]([^'"]+)['"](?=\s*(?:,|$))/))) {
      constraints.push(arg[1]);
      rest = rest.slice(arg[0].length);
    }
    const inlineGroup = line.match(/group\s*(?:=>|:)\s*\[?\s*:?(\w+)/);
    const groups = [...groupStack, inlineGroup?.[1] ?? ""].join(" ").toLowerCase();
    const scope: PackageScope = /develop|test/.test(groups) ? "dev" : "prod";
    out.push(mk(gem[1], constraints.length ? constraints.join(", ") : null, "rubygems", scope, declaredIn));
  }
  return out;
}

/**
 * `Gemfile.lock` resolved versions. Every `specs:` block (under GEM, GIT and
 * PATH sections alike) lists resolved gems as 4-space-indented `name (x.y.z)`
 * lines; the 6-space lines beneath each are that gem's own dependency
 * constraints, not resolutions, and are skipped. Platform-suffixed versions
 * (`1.15.4-x86_64-linux`) keep only the version half — gem versions themselves
 * never contain `-`. Used to backfill Gemfile entries declared without an
 * inline constraint; the lock never introduces packages (transitive gems are
 * not declared dependencies).
 */
function parseGemfileLock(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let inSpecs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inSpecs = false; continue; } // section header (GEM/GIT/PLATFORMS/…)
    if (/^ {2}\S/.test(line)) { inSpecs = /^ {2}specs:\s*$/.test(line); continue; }
    if (!inSpecs) continue;
    const spec = line.match(/^ {4}(\S+) \(([^)]+)\)\s*$/);
    if (!spec) continue;
    const version = spec[2].split("-")[0];
    if (!versions.has(spec[1])) versions.set(spec[1], version);
  }
  return versions;
}

function parsePubspec(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const lines = text.split(/\r?\n/);
  let scope: PackageScope | null = null;
  for (const raw of lines) {
    if (/^dependencies\s*:/.test(raw)) { scope = "prod"; continue; }
    if (/^dev_dependencies\s*:/.test(raw)) { scope = "dev"; continue; }
    if (/^\S/.test(raw)) { scope = null; continue; } // dedented out of a deps block
    if (!scope) continue;
    // A dependency is a 2-space-indented `name:` key. `  name: ^1.2.3` or `  name:` (nested sdk/git/path).
    const m = raw.match(/^ {2}([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    let version: string | null = m[2].trim() || null;
    if (version && /^(sdk|git|path|hosted)\s*:/.test(version)) version = null; // non-semver source
    out.push(mk(name, version, "pub", scope, declaredIn));
  }
  return out;
}

function parsePython(text: string, declaredIn: string, isDev: boolean): RawPkg[] {
  // requirements.txt-style lines (also used for parsed pyproject/Pipfile dep arrays).
  const out: RawPkg[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue; // skip -r/-e/-i flags
    if (/^(https?|git\+|file):/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*(\[[^\]]*\])?\s*([<>=!~]=?.*)?$/);
    if (!m) continue;
    const version = m[3]?.trim() || null;
    out.push(mk(m[1], version, "pypi", isDev ? "dev" : "prod", declaredIn));
  }
  return out;
}

function parsePyproject(text: string, declaredIn: string): RawPkg[] {
  // Minimal section scan: [project] dependencies = [...], optional-dependencies (dev),
  // [tool.poetry.dependencies] / [tool.poetry.group.*.dependencies] (dev when group != main).
  const out: RawPkg[] = [];
  const lines = text.split(/\r?\n/);
  let mode: "none" | "pep621" | "poetry-main" | "poetry-dev" = "none";
  for (const raw of lines) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const s = section[1];
      if (/optional-dependencies/.test(s)) mode = "poetry-dev";
      else if (/tool\.poetry\.dependencies/.test(s)) mode = "poetry-main";
      else if (/tool\.poetry\.(group\..*\.)?dependencies/.test(s)) mode = "poetry-dev";
      else mode = "none";
      continue;
    }
    if (mode === "none") {
      const arr = line.match(/^dependencies\s*=\s*\[/);
      if (arr) mode = "pep621";
    }
    if (mode === "pep621") {
      // each quoted entry "pkg>=1.0"
      for (const q of line.matchAll(/["']([A-Za-z0-9_.-]+[^"']*)["']/g)) {
        const dep = parsePython(q[1], declaredIn, false);
        out.push(...dep);
      }
      if (line.includes("]")) mode = "none";
      continue;
    }
    if (mode === "poetry-main" || mode === "poetry-dev") {
      const dep = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (dep && dep[1].toLowerCase() !== "python") {
        const v = dep[2].match(/"([^"]+)"/)?.[1] ?? null;
        out.push(mk(dep[1], v, "pypi", mode === "poetry-dev" ? "dev" : "prod", declaredIn));
      }
    }
  }
  return out;
}

function parseSwiftPackage(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  // .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.0.0")
  // .package(name: "Foo", url: "...", .upToNextMajor(from: "1.0.0"))
  const re = /\.package\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const args = m[1];
    const url = args.match(/url:\s*"([^"]+)"/)?.[1];
    let name = args.match(/name:\s*"([^"]+)"/)?.[1];
    if (!name && url) name = url.replace(/\.git$/, "").replace(/\/+$/, "").split("/").pop();
    if (!name) continue;
    const version = args.match(/(?:from|exact|revision|branch):\s*"([^"]+)"/)?.[1] ?? null;
    out.push(mk(name, version, "swiftpm", "prod", declaredIn));
  }
  return out;
}

function parsePodfile(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^pod\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/);
    if (!m) continue;
    out.push(mk(m[1].split("/")[0], m[2] ?? null, "cocoapods", "prod", declaredIn)); // strip Pod/Subspec
  }
  return out;
}

function parseVcpkg(text: string, declaredIn: string): RawPkg[] {
  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { return []; }
  const out: RawPkg[] = [];
  const deps = json.dependencies;
  if (Array.isArray(deps)) {
    for (const d of deps) {
      if (typeof d === "string") out.push(mk(d, null, "vcpkg", "prod", declaredIn));
      else if (d && typeof d === "object" && typeof (d as Record<string, unknown>).name === "string") {
        const o = d as Record<string, unknown>;
        out.push(mk(o.name as string, (typeof o["version>="] === "string" ? o["version>="] as string : null), "vcpkg", "prod", declaredIn));
      }
    }
  }
  return out;
}

function parseConan(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  let scope: PackageScope | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const s = sec[1].toLowerCase();
      scope = s === "requires" ? "prod" : (s === "tool_requires" || s === "build_requires") ? "dev" : null;
      continue;
    }
    if (!scope || !line) continue;
    const m = line.match(/^([A-Za-z0-9_.+-]+)\/([^@\s]+)/); // name/version (fmt/9.1.0)
    if (m) out.push(mk(m[1], m[2], "conan", scope, declaredIn));
  }
  return out;
}

function parseSbt(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  // "group" %%? "artifact" % "version" [% Test]  — sbt resolves Maven coordinates.
  const re = /"([^"]+)"\s*%%?\s*"([^"]+)"\s*%\s*"([^"]+)"(?:\s*%\s*(\w+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const scope: PackageScope = /^(test|it)$/i.test(m[4] ?? "") ? "dev" : "prod";
    out.push(mk(`${m[1]}:${m[2]}`, m[3], "maven", scope, declaredIn));
  }
  return out;
}

function parseCpanfile(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const re = /^\s*(?:requires|recommends|suggests)\s+['"]([^'"]+)['"]\s*(?:,\s*['"]?([0-9._]+)['"]?)?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(mk(m[1], m[2] ?? null, "cpan", "prod", declaredIn));
  return out;
}

function parseRockspec(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const block = text.match(/dependencies\s*=\s*\{([\s\S]*?)\}/);
  if (!block) return out;
  for (const q of block[1].matchAll(/["']([^"']+)["']/g)) {
    const parts = q[1].trim().split(/\s+/); // "name >= 1.0"
    const name = parts[0];
    if (!name || name.toLowerCase() === "lua") continue; // skip the runtime itself
    out.push(mk(name, parts.slice(1).join(" ") || null, "luarocks", "prod", declaredIn));
  }
  return out;
}

function parsePipfile(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  let scope: PackageScope | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const s = sec[1].toLowerCase();
      scope = s === "packages" ? "prod" : s === "dev-packages" ? "dev" : null;
      continue;
    }
    if (!scope) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const v = m[2].match(/"([^"]*)"/)?.[1] ?? null;
    out.push(mk(m[1], v && v !== "*" ? v : null, "pypi", scope, declaredIn));
  }
  return out;
}

function parseCabal(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const seen = new Set<string>();
  // `build-depends: base >=4.7 && <5, text, aeson >= 1.5` — possibly multi-line
  // (continuation lines are indented). Collect from each build-depends block.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*build-depends\s*:(.*)$/i);
    if (!m) continue;
    let block = m[1];
    for (let j = i + 1; j < lines.length; j++) {
      // Continuation: an indented line that isn't a new `field:` declaration.
      if (/^\s+\S/.test(lines[j]) && !/^\s*[A-Za-z-]+\s*:/.test(lines[j])) block += " " + lines[j];
      else break;
    }
    for (const part of block.split(",")) {
      const name = part.trim().match(/^([A-Za-z][\w-]*)/)?.[1];
      if (name && !seen.has(name)) { seen.add(name); out.push(mk(name, null, "hackage", "prod", declaredIn)); }
    }
  }
  return out;
}

function parseClojureDeps(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: string | null) => {
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(mk(name, version, "clojars", "prod", declaredIn)); }
  };
  // deps.edn: `org.clojure/clojure {:mvn/version "1.11.1"}`
  for (const m of text.matchAll(/([\w.\-]+\/[\w.\-]+)\s*\{[^}]*:mvn\/version\s+"([^"]+)"/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/([\w.\-]+\/[\w.\-]+)\s*\{[^}]*:(?:git|local)\/(?:url|root)/g)) add(m[1], null);
  // Leiningen project.clj: `:dependencies [[ring "1.9.0"] [compojure "1.7.0"]]`
  for (const m of text.matchAll(/\[\s*([\w.\-]+(?:\/[\w.\-]+)?)\s+"([^"]+)"\s*\]/g)) add(m[1], m[2]);
  return out;
}

function parseRebar(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  // {deps, [ {cowboy, "2.10.0"}, {jsx, "3.1.0"}, {gun, {git, "…"}} ]}.
  const block = text.match(/\{\s*deps\s*,\s*\[([\s\S]*?)\]\s*\}/);
  if (!block) return out;
  for (const m of block[1].matchAll(/\{\s*([a-z][\w]*)\s*,\s*(?:"([^"]+)")?/g)) {
    out.push(mk(m[1], m[2] ?? null, "hex", "prod", declaredIn));
  }
  return out;
}

function parseMix(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  // Dep tuples: {:phoenix, "~> 1.7"}, {:credo, "~> 1.7", only: [:dev, :test]},
  // {:foo, github: "org/foo"}. Require a version string or a dep-option keyword
  // as the second element so code tuples like `{:ok, result}` are rejected.
  const re = /\{\s*:([a-z_]\w*)\s*,\s*([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const rest = m[2];
    if (!/^\s*(?:"|[a-z_]+:)/.test(rest)) continue; // not a dependency tuple
    const version = rest.match(/^\s*"([^"]+)"/)?.[1] ?? null;
    const dev = /only:\s*(?:\[[^\]]*:(?:dev|test)|:(?:dev|test))/.test(rest);
    out.push(mk(name, version, "hex", dev ? "dev" : "prod", declaredIn));
  }
  return out;
}

// ─── Manifest discovery ────────────────────────────────────────────────────

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/bin/**", "**/obj/**", "**/vendor/**"];

async function readIf(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

/** Parse all dependencies declared at a single root directory. */
/**
 * `.gitmodules` — vendored submodules as declared dependencies. The package
 * name is the remote repo's basename (stable identity across checkouts); the
 * recorded "version" is null (submodules pin by commit, not by version).
 */
function parseGitmodules(text: string, declaredIn: string): RawPkg[] {
  const out: RawPkg[] = [];
  let path: string | null = null;
  let url: string | null = null;
  const flush = () => {
    if (!path && !url) return;
    const fromUrl = url?.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/i, "");
    const fromPath = path?.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();
    const name = fromUrl || fromPath;
    if (name) out.push(mk(name, null, "git", "prod", declaredIn));
    path = null;
    url = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[submodule\b/.test(line)) {
      flush();
      continue;
    }
    const kv = line.match(/^\s*(path|url)\s*=\s*(.+?)\s*$/);
    if (kv) {
      if (kv[1] === "path") path = kv[2]!;
      else url = kv[2]!;
    }
  }
  flush();
  return out;
}

async function collectAtRoot(absRoot: string, rel: string): Promise<RawPkg[]> {
  const out: RawPkg[] = [];
  const at = (name: string) => (rel ? `${rel}/${name}` : name);

  const pkg = await readIf(join(absRoot, "package.json"));
  if (pkg) out.push(...parseNpm(pkg, at("package.json")));

  const composer = await readIf(join(absRoot, "composer.json"));
  if (composer) out.push(...parseComposer(composer, at("composer.json")));

  const pom = await readIf(join(absRoot, "pom.xml"));
  if (pom) out.push(...parsePom(pom, at("pom.xml")));

  for (const g of ["build.gradle.kts", "build.gradle"]) {
    const gradle = await readIf(join(absRoot, g));
    if (gradle) { out.push(...parseGradle(gradle, at(g))); break; }
  }

  const goMod = await readIf(join(absRoot, "go.mod"));
  if (goMod) out.push(...parseGoMod(goMod, at("go.mod")));

  const cargo = await readIf(join(absRoot, "Cargo.toml"));
  if (cargo) out.push(...parseCargo(cargo, at("Cargo.toml")));

  const gemfile = await readIf(join(absRoot, "Gemfile"));
  if (gemfile) {
    const gems = parseGemfile(gemfile, at("Gemfile"));
    // Gemfiles routinely declare gems without a constraint (versions live in
    // the lock) — backfill those from Gemfile.lock; an explicit constraint in
    // the Gemfile stays authoritative as the *declared* version.
    const lock = await readIf(join(absRoot, "Gemfile.lock"));
    if (lock) {
      const locked = parseGemfileLock(lock);
      for (const g of gems) g.version ??= locked.get(g.name) ?? null;
    }
    out.push(...gems);
  }

  const pubspec = await readIf(join(absRoot, "pubspec.yaml"));
  if (pubspec) out.push(...parsePubspec(pubspec, at("pubspec.yaml")));

  const pyproject = await readIf(join(absRoot, "pyproject.toml"));
  if (pyproject) out.push(...parsePyproject(pyproject, at("pyproject.toml")));

  const pipfile = await readIf(join(absRoot, "Pipfile"));
  if (pipfile) out.push(...parsePipfile(pipfile, at("Pipfile")));

  const swiftPkg = await readIf(join(absRoot, "Package.swift"));
  if (swiftPkg) out.push(...parseSwiftPackage(swiftPkg, at("Package.swift")));

  const podfile = await readIf(join(absRoot, "Podfile"));
  if (podfile) out.push(...parsePodfile(podfile, at("Podfile")));

  const vcpkg = await readIf(join(absRoot, "vcpkg.json"));
  if (vcpkg) out.push(...parseVcpkg(vcpkg, at("vcpkg.json")));

  const conan = await readIf(join(absRoot, "conanfile.txt"));
  if (conan) out.push(...parseConan(conan, at("conanfile.txt")));

  const sbt = await readIf(join(absRoot, "build.sbt"));
  if (sbt) out.push(...parseSbt(sbt, at("build.sbt")));

  const cpanfile = await readIf(join(absRoot, "cpanfile"));
  if (cpanfile) out.push(...parseCpanfile(cpanfile, at("cpanfile")));

  const mix = await readIf(join(absRoot, "mix.exs"));
  if (mix) out.push(...parseMix(mix, at("mix.exs")));

  const rebar = await readIf(join(absRoot, "rebar.config"));
  if (rebar) out.push(...parseRebar(rebar, at("rebar.config")));

  const depsEdn = await readIf(join(absRoot, "deps.edn"));
  if (depsEdn) out.push(...parseClojureDeps(depsEdn, at("deps.edn")));

  const projectClj = await readIf(join(absRoot, "project.clj"));
  if (projectClj) out.push(...parseClojureDeps(projectClj, at("project.clj")));

  // Vendored git submodules — the de-facto dependency channel for ecosystems
  // without a package manager (Delphi, plain C, game engines): the library IS
  // an external dependency even though its source sits inside the repo.
  const gitmodules = await readIf(join(absRoot, ".gitmodules"));
  if (gitmodules) out.push(...parseGitmodules(gitmodules, at(".gitmodules")));

  // Multi-file ecosystems within this root (shallow scan).
  const csprojFiles = await fg(["**/*.csproj", "**/Directory.Packages.props", "**/packages.config"], {
    cwd: absRoot, ignore: IGNORE, deep: 3, absolute: false,
  });
  for (const f of csprojFiles.slice(0, 50)) {
    const t = await readIf(join(absRoot, f));
    if (t) out.push(...parseCsproj(t, at(f)));
  }

  const reqFiles = await fg(["requirements*.txt", "**/requirements*.txt"], {
    cwd: absRoot, ignore: IGNORE, deep: 2, absolute: false,
  });
  for (const f of reqFiles.slice(0, 20)) {
    const t = await readIf(join(absRoot, f));
    if (t) out.push(...parsePython(t, at(f), /dev|test/i.test(f)));
  }

  const rockspecs = await fg(["*.rockspec", "**/*.rockspec"], {
    cwd: absRoot, ignore: IGNORE, deep: 2, absolute: false,
  });
  for (const f of rockspecs.slice(0, 10)) {
    const t = await readIf(join(absRoot, f));
    if (t) out.push(...parseRockspec(t, at(f)));
  }

  const cabals = await fg(["*.cabal", "**/*.cabal"], {
    cwd: absRoot, ignore: IGNORE, deep: 2, absolute: false,
  });
  for (const f of cabals.slice(0, 10)) {
    const t = await readIf(join(absRoot, f));
    if (t) out.push(...parseCabal(t, at(f)));
  }

  return out;
}

/**
 * Collect, de-duplicate, and categorise every declared dependency across the
 * analyzed root and each sub-project root. Dedup key is `<ecosystem> <name>`
 * (a space can't appear in either half); first declaration wins for
 * version/location, scope upgrades dev→prod if it appears as a prod dep anywhere.
 */
export async function collectExternalPackages(
  projectRoot: string,
  subRoots: readonly string[],
): Promise<ExternalPackage[]> {
  const root = resolve(projectRoot);
  const roots = ["", ...subRoots].filter((r, i, a) => a.indexOf(r) === i);
  const byKey = new Map<string, ExternalPackage>();

  for (const rel of roots) {
    const raws = await collectAtRoot(rel ? resolve(root, rel) : root, rel.replace(/\\/g, "/"));
    for (const raw of raws) {
      const key = `${raw.ecosystem} ${raw.name.toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        // Prefer the strongest scope (prod beats dev/peer/optional).
        if (raw.scope === "prod") existing.scope = "prod";
        if (!existing.version && raw.version) existing.version = raw.version;
        continue;
      }
      const { category } = classify(raw.name);
      byKey.set(key, { ...raw, category });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => byOrdinal(a.ecosystem, b.ecosystem) || byOrdinal(a.name, b.name),
  );
}

/**
 * Build a PHP namespace→package map from Composer's installed-package metadata
 * (`vendor/composer/installed.json`, which lists every installed package's
 * PSR-4/PSR-0 autoload namespaces in one file). This is what makes Composer
 * usage reliable: a `use Vendor\Ns\Class` import resolves to the package whose
 * autoload namespace is its longest prefix. Empty when vendor/ isn't present
 * (then Composer usage stays "unknown" — never falsely "unused").
 *
 * Keys are lowercased, trailing `\` trimmed; values are lowercased package names.
 */
export async function collectComposerAutoload(
  projectRoot: string,
  subRoots: readonly string[],
): Promise<Map<string, string>> {
  const root = resolve(projectRoot);
  const roots = ["", ...subRoots].filter((r, i, a) => a.indexOf(r) === i);
  const map = new Map<string, string>();

  for (const rel of roots) {
    const abs = rel ? resolve(root, rel) : root;
    const raw = await readIf(join(abs, "vendor", "composer", "installed.json"));
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    // Composer 2 wraps the list in `{ packages: [...] }`; Composer 1 is a bare array.
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as { packages?: unknown }).packages)
          ? (parsed as { packages: unknown[] }).packages
          : []);
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === "string" ? e.name.toLowerCase() : null;
      if (!name) continue;
      const autoload = e.autoload as Record<string, unknown> | undefined;
      if (!autoload) continue;
      for (const key of ["psr-4", "psr-0"]) {
        const block = autoload[key] as Record<string, unknown> | undefined;
        if (!block || typeof block !== "object") continue;
        for (const ns of Object.keys(block)) {
          const norm = ns.replace(/\\+$/, "").toLowerCase();
          if (norm && !map.has(norm)) map.set(norm, name);
        }
      }
    }
  }
  return map;
}

// ─── Usage cross-check ───────────────────────────────────────────────────

/** Ecosystems whose imports map cleanly enough to assert "declared-but-unused". */
const RELIABLE_UNUSED = new Set<PackageEcosystem>(["npm", "go", "cargo", "pub"]);

/**
 * Map a source language to the manifest ecosystem(s) its imports resolve
 * against. Most languages have one; Swift (SwiftPM + CocoaPods) and C/C++
 * (vcpkg + Conan) have two coexisting package managers, so an import is matched
 * against both.
 */
function ecosystemsForLanguage(lang: Language): readonly PackageEcosystem[] {
  switch (lang) {
    case "typescript":
    case "javascript": return ["npm"];
    case "python": return ["pypi"];
    case "go": return ["go"];
    case "rust": return ["cargo"];
    case "dart": return ["pub"];
    case "ruby": return ["rubygems"];
    case "php": return ["composer"];
    case "csharp":
    case "vb": return ["nuget"];
    case "java":
    case "kotlin":
    case "scala": return ["maven"];
    case "swift":
    case "objc": return ["swiftpm", "cocoapods"];
    case "c":
    case "cpp": return ["vcpkg", "conan"];
    case "lua": return ["luarocks"];
    case "perl": return ["cpan"];
    case "elixir":
    case "erlang": return ["hex"];
    case "haskell": return ["hackage"];
    // clojure: Clojars group/artifact vs Clojure namespaces map too loosely to
    // assert usage — declared-only (no entry ⇒ usage unknown).
    default: return [];
  }
}

/** Reduce an import source to the package "root" key for its ecosystem (or null to skip). */
function importRoot(source: string, eco: PackageEcosystem): string | null {
  const s = source.trim();
  if (!s) return null;
  switch (eco) {
    case "npm": {
      if (s.startsWith(".") || s.startsWith("/") || s.startsWith("@/") || s.startsWith("~")) return null;
      if (s.startsWith("@")) {
        const parts = s.split("/");
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null;
      }
      return s.split("/")[0].toLowerCase();
    }
    case "pypi":
      if (s.startsWith(".")) return null;
      return s.split(".")[0].toLowerCase().replace(/_/g, "-");
    case "cargo": {
      const head = s.split("::")[0].toLowerCase();
      if (["crate", "self", "super", "std", "core", "alloc"].includes(head)) return null;
      return head.replace(/_/g, "-");
    }
    case "pub": {
      const m = s.match(/^package:([A-Za-z0-9_]+)/);
      return m ? m[1].toLowerCase() : null;
    }
    case "rubygems":
      if (s.startsWith(".")) return null;
      return s.split("/")[0].toLowerCase();
    case "go":
      // Full module path — matched by prefix in the package loop.
      return s.startsWith(".") ? null : s.toLowerCase();
    case "nuget":
      // Full namespace (`Microsoft.EntityFrameworkCore`) — matched by prefix.
      return s.toLowerCase();
    case "cpan":
      // Full Perl module (`Foo::Bar`) — matched by module-prefix.
      return s.toLowerCase();
    case "composer":
      // Full PHP namespace (`Illuminate\Support\Facades\Route`) — resolved to a
      // package via the PSR-4 autoload map when vendor/ is present.
      return s.startsWith(".") ? null : s.toLowerCase();
    case "swiftpm":
    case "cocoapods": {
      // Swift `import Alamofire` → module name; Obj-C `#import <AFNetworking/AFNetworking.h>`
      // or `@import AFNetworking;` → first path segment (header extension stripped).
      const head = s.split("/")[0].replace(/\.(h|hpp|m|mm)$/, "");
      return /^[A-Za-z_]\w*$/.test(head) ? head.toLowerCase() : null;
    }
    case "luarocks":
      // `require "lapis.application"` → first segment.
      return s.split(/[./]/)[0].toLowerCase();
    case "hex":
      // `import Phoenix.Controller` → first module segment ≈ Hex package
      // (`Phoenix`→phoenix, `Ecto.Query`→ecto). CamelCase → lowercase.
      return s.split(".")[0].toLowerCase();
    case "hackage": {
      // `import Data.Aeson`/`Web.Scotty`/`Network.Wai.Handler.Warp` → LAST module
      // segment ≈ package (aeson, scotty, warp, text, bytestring…). Misses the
      // few mismatches (Data.Map→containers); positive-only handles that.
      const parts = s.split(".");
      return parts[parts.length - 1].toLowerCase();
    }
    case "vcpkg":
    case "conan":
      // `#include <fmt/format.h>` → first path segment ≈ package; stdlib headers
      // (no slash) simply won't match any package (these are positive-only).
      return s.split("/")[0].toLowerCase().replace(/\.(h|hpp|hxx|hh)$/, "");
    default:
      return null; // maven/gradle/composer: namespace≠artifact
  }
}

/** Normalise a package name to the form `importRoot` produces, for comparison. */
function packageKey(pkg: ExternalPackage): string {
  switch (pkg.ecosystem) {
    case "cargo":
    case "pypi":
      return pkg.name.toLowerCase().replace(/_/g, "-");
    default:
      return pkg.name.toLowerCase();
  }
}

/**
 * Mark each package used/unused by cross-referencing declarations against the
 * imports in analyzed files. Only npm/go/cargo/pub assert "unused" (clean
 * import→package mapping); pypi/rubygems/nuget/Swift/native/Lua/Perl are
 * positive-only (a hit marks "used", a miss is "unknown" — never "unused");
 * maven/gradle/composer stay unknown (namespace≠artifact).
 */
export function attachPackageUsage(
  packages: ExternalPackage[],
  analyses: readonly FileAnalysis[],
  opts?: { composerAutoload?: ReadonlyMap<string, string> },
): void {
  const counts = new Map<PackageEcosystem, Map<string, number>>();
  const bump = (eco: PackageEcosystem, key: string) => {
    let b = counts.get(eco);
    if (!b) counts.set(eco, (b = new Map()));
    b.set(key, (b.get(key) ?? 0) + 1);
  };

  for (const fa of analyses) {
    const ecos = ecosystemsForLanguage(fa.language);
    if (ecos.length === 0) continue;
    for (const imp of fa.imports) {
      for (const eco of ecos) {
        const root = importRoot(imp.source, eco);
        if (root) bump(eco, root);
      }
    }
  }

  // Sum the import counts in a bucket whose key satisfies a prefix/containment test.
  const matchCount = (bucket: Map<string, number> | undefined, test: (key: string) => boolean): number => {
    if (!bucket) return 0;
    let c = 0;
    for (const [k, n] of bucket) if (test(k)) c += n;
    return c;
  };

  // Composer: resolve each imported namespace to the package whose PSR-4 prefix
  // is its longest match, accumulating usage per package (only when the autoload
  // map is available, i.e. vendor/ is present).
  const composerUsed = new Map<string, number>();
  const autoload = opts?.composerAutoload;
  if (autoload && autoload.size > 0) {
    for (const [ns, n] of counts.get("composer") ?? []) {
      let owner: string | undefined;
      let bestLen = -1;
      for (const [key, pkgName] of autoload) {
        if ((ns === key || ns.startsWith(key + "\\")) && key.length > bestLen) {
          owner = pkgName;
          bestLen = key.length;
        }
      }
      if (owner) composerUsed.set(owner, (composerUsed.get(owner) ?? 0) + n);
    }
  }

  for (const pkg of packages) {
    const name = pkg.name.toLowerCase();
    let count: number;
    switch (pkg.ecosystem) {
      case "go": // module path: equal to, or an ancestor of, an import path
        count = matchCount(counts.get("go"), (p) => p === name || p.startsWith(name + "/"));
        pkg.used = count > 0;
        pkg.usageCount = count;
        continue; // reliable
      case "nuget": // namespace equals/extends the package id (or vice versa)
        count = matchCount(counts.get("nuget"), (ns) => ns === name || ns.startsWith(name + ".") || name.startsWith(ns + "."));
        break;
      case "cpan": // Perl module equals/extends the dist's top module (or vice versa)
        count = matchCount(counts.get("cpan"), (m) => m === name || m.startsWith(name + "::") || name.startsWith(m + "::"));
        break;
      case "composer": // resolved via the PSR-4 autoload map (positive-only)
        count = composerUsed.get(name) ?? 0;
        break;
      default:
        count = counts.get(pkg.ecosystem)?.get(packageKey(pkg)) ?? 0;
    }

    if (count > 0) {
      pkg.used = true;
      pkg.usageCount = count;
    } else if (RELIABLE_UNUSED.has(pkg.ecosystem)) {
      pkg.used = false;
      pkg.usageCount = 0;
    }
    // else: unknown (positive-only ecosystems / no reliable mapping).
  }
}

// ─── Framework derivation ──────────────────────────────────────────────────

/**
 * Derive framework detections from recognised packages. Confidence reflects how
 * the dependency is consumed: a prod/peer dependency that's also imported is a
 * "high" signal; a dev-only or declared-but-unused one is "medium".
 */
export function deriveFrameworksFromPackages(packages: readonly ExternalPackage[]): FrameworkDetection[] {
  const byId = new Map<string, FrameworkDetection>();
  for (const pkg of packages) {
    const known = classify(pkg.name);
    if (!known.framework) continue;
    const strong = (pkg.scope === "prod" || pkg.scope === "peer") && pkg.used !== false;
    const detection: FrameworkDetection = {
      id: known.framework.id,
      name: known.framework.name,
      confidence: strong ? "high" : "medium",
      detectedVia: `${pkg.ecosystem} dependency (${pkg.name})`,
    };
    const existing = byId.get(detection.id);
    // Keep the strongest confidence seen for this framework id.
    if (!existing || (existing.confidence !== "high" && detection.confidence === "high")) {
      byId.set(detection.id, detection);
    }
  }
  return [...byId.values()];
}

/**
 * Merge rule-based detections (from `framework-detector.ts`) with inventory-
 * derived ones. The rule-based entry wins on an id collision (its `detectedVia`
 * is more specific and keeps existing output stable); inventory-only frameworks
 * are appended. Order: rule-based first, then new ones alphabetically by name.
 */
export function mergeFrameworkDetections(
  ruleBased: readonly FrameworkDetection[],
  derived: readonly FrameworkDetection[],
): FrameworkDetection[] {
  const byId = new Map<string, FrameworkDetection>();
  for (const f of ruleBased) byId.set(f.id, f);
  const added: FrameworkDetection[] = [];
  for (const f of derived) {
    if (!byId.has(f.id)) {
      byId.set(f.id, f);
      added.push(f);
    }
  }
  added.sort((a, b) => byOrdinal(a.name, b.name));
  return [...ruleBased, ...added];
}
