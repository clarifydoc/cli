import type { Language, PackageCategory, PackageEcosystem } from "../types/analysis.js";
import type {
  LanguagePluginMeta,
  LanguagePluginManifest,
  PackageManagerSpec,
  ConfigSourceSpec,
  ProxySourceSpec,
  ServiceConfigSpec,
  LanguageComplexitySpec,
  LanguageControlFlowSpec,
  LanguageRegexControlFlowSpec,
  SecurityRule,
  AstExtractorHooks,
  FrameworkRule,
} from "../types/language-plugin.js";
import type { RegexLangSpec } from "./plugins/shared/regex-base.js";
import { registerBuiltinTypes } from "./shared/builtin-types.js";
import { registerTransparentTypeWrappers } from "./shared/type-parser.js";
import { registerCallPatterns } from "./shared/call-patterns.js";
import { registerCallExtraction } from "./shared/call-graph.js";
import { registerLinkScoringData } from "./shared/link-scoring.js";
import { registerExtensionFamilies } from "./plugins/shared/path-utils.js";
import { registerGrammar } from "../parsers/parser-manager.js";

// ─── Static tier: plugin manifests (eager, cheap) ─────────────────────────
// Each plugin's manifest.ts is a leaf module carrying only pure data —
// extensions, grammar locations, framework rules, import-resolution string
// lists. The heavy plugin bodies (meta.ts and everything they import) load
// lazily via the thunk map below.

import { typescriptManifest, javascriptManifest } from "./plugins/javascript/manifest.js";
import { csharpManifest } from "./plugins/csharp/manifest.js";
import { pythonManifest } from "./plugins/python/manifest.js";
import { javaManifest, kotlinManifest } from "./plugins/java-kotlin/manifest.js";
import { pascalManifest, dfmManifest } from "./plugins/pascal/manifest.js";
import { phpManifest } from "./plugins/php/manifest.js";
import { goManifest } from "./plugins/go/manifest.js";
import { rustManifest } from "./plugins/rust/manifest.js";
import { rubyManifest } from "./plugins/ruby/manifest.js";
import { swiftManifest } from "./plugins/swift/manifest.js";
import { luaManifest } from "./plugins/lua/manifest.js";
import { scalaManifest } from "./plugins/scala/manifest.js";
import { perlManifest } from "./plugins/perl/manifest.js";
import { vbManifest } from "./plugins/vb/manifest.js";
import { sqlManifest } from "./plugins/sql/manifest.js";
import { cManifest } from "./plugins/c/manifest.js";
import { cppManifest } from "./plugins/cpp/manifest.js";
import { prismaManifest } from "./plugins/prisma/manifest.js";
import { dartManifest } from "./plugins/dart/manifest.js";
import { elixirManifest } from "./plugins/elixir/manifest.js";
import { erlangManifest } from "./plugins/erlang/manifest.js";
import { objcManifest } from "./plugins/objc/manifest.js";
import { haskellManifest } from "./plugins/haskell/manifest.js";
import { clojureManifest } from "./plugins/clojure/manifest.js";
import { blazorManifest } from "./plugins/blazor/manifest.js";
import { htmlManifest } from "./plugins/html/manifest.js";
import { erbManifest } from "./plugins/erb/manifest.js";
import { heexManifest } from "./plugins/heex/manifest.js";
import { handlebarsManifest, liquidManifest, razorManifest, velocityManifest } from "./plugins/templates/manifest.js";
import { qmlManifest } from "./plugins/qml/manifest.js";
import { qtuiManifest } from "./plugins/qtui/manifest.js";
import { xamlManifest } from "./plugins/xaml/manifest.js";
import { jspManifest } from "./plugins/jsp/manifest.js";
import { springxmlManifest } from "./plugins/springxml/manifest.js";
import { jsightManifest } from "./plugins/jsight/manifest.js";
import { serverlessManifest } from "./plugins/serverless/manifest.js";
import { coredataManifest } from "./plugins/coredata/manifest.js";
import { storyboardManifest } from "./plugins/storyboard/manifest.js";
import { terraformManifest } from "./plugins/terraform/manifest.js";
import { protobufManifest } from "./plugins/protobuf/manifest.js";
import { openapiManifest } from "./plugins/openapi/manifest.js";
import { graphqlManifest } from "./plugins/graphql/manifest.js";
import { wsdlManifest } from "./plugins/wsdl/manifest.js";
import { groovyManifest } from "./plugins/groovy/manifest.js";
import { powershellManifest } from "./plugins/powershell/manifest.js";
import { bashManifest } from "./plugins/bash/manifest.js";
import { batchManifest } from "./plugins/batch/manifest.js";
import { fsharpManifest } from "./plugins/fsharp/manifest.js";
import { coffeeManifest } from "./plugins/coffeescript/manifest.js";
import { rManifest } from "./plugins/r/manifest.js";
import { juliaManifest } from "./plugins/julia/manifest.js";
import { crystalManifest } from "./plugins/crystal/manifest.js";
import { zigManifest } from "./plugins/zig/manifest.js";
import { ocamlManifest } from "./plugins/ocaml/manifest.js";
import { rakuManifest } from "./plugins/raku/manifest.js";
import { commonLispManifest, racketManifest, schemeManifest } from "./plugins/lisp/manifest.js";
import { haxeManifest } from "./plugins/haxe/manifest.js";
import { mojoManifest } from "./plugins/mojo/manifest.js";
import { lessManifest, sassManifest, scssManifest } from "./plugins/stylesheet/manifest.js";
import { autohotkeyManifest } from "./plugins/autohotkey/manifest.js";
import { autoitManifest } from "./plugins/autoit/manifest.js";
import { applescriptManifest } from "./plugins/applescript/manifest.js";
import { nimManifest } from "./plugins/nim/manifest.js";
import { dManifest } from "./plugins/dlang/manifest.js";
import { vManifest } from "./plugins/vlang/manifest.js";
import { fortranManifest } from "./plugins/fortran/manifest.js";

/** All plugin manifests, in registration order (order is observable — keep stable). */
const ALL_MANIFESTS: readonly LanguagePluginManifest[] = [
  typescriptManifest, javascriptManifest,
  csharpManifest, pythonManifest,
  javaManifest, kotlinManifest,
  pascalManifest, dfmManifest,
  phpManifest,
  goManifest, rustManifest, rubyManifest, swiftManifest, luaManifest, scalaManifest, perlManifest,
  vbManifest, sqlManifest, cManifest, cppManifest, prismaManifest, dartManifest, elixirManifest, erlangManifest, objcManifest,
  haskellManifest, clojureManifest, blazorManifest, htmlManifest, erbManifest, heexManifest, handlebarsManifest, liquidManifest, velocityManifest, razorManifest, qmlManifest, qtuiManifest, xamlManifest,
  jspManifest, springxmlManifest, jsightManifest, serverlessManifest, coredataManifest, storyboardManifest, terraformManifest, protobufManifest,
  openapiManifest, graphqlManifest, wsdlManifest,
  groovyManifest,
  powershellManifest,
  bashManifest,
  batchManifest,
  fsharpManifest,
  coffeeManifest,
  rManifest,
  juliaManifest,
  crystalManifest,
  zigManifest,
  ocamlManifest,
  rakuManifest,
  racketManifest,
  schemeManifest,
  commonLispManifest,
  haxeManifest,
  mojoManifest,
  scssManifest,
  sassManifest,
  lessManifest,
  autohotkeyManifest,
  autoitManifest,
  applescriptManifest,
  nimManifest,
  dManifest,
  vManifest,
  fortranManifest,
];

const MANIFEST_BY_LANGUAGE = new Map<Language, LanguagePluginManifest>();
for (const manifest of ALL_MANIFESTS) {
  MANIFEST_BY_LANGUAGE.set(manifest.language, manifest);
  registerGrammar(manifest.language, manifest.grammar);
}

/** Manifest for a language (static data — always available, no load needed). */
export function manifestFor(language: Language): LanguagePluginManifest | undefined {
  return MANIFEST_BY_LANGUAGE.get(language);
}

// ─── Lazy tier: plugin metas behind a static thunk map ────────────────────
// One loader per plugin DIRECTORY (family plugins load all member metas at
// once). The thunks are statically analyzable so bundlers (tsdown/rolldown with
// ESM code splitting) emit one lazy chunk per plugin.

interface PluginLoader {
  readonly languages: readonly Language[];
  readonly load: () => Promise<readonly LanguagePluginMeta[]>;
}

const LOADERS: readonly PluginLoader[] = [
  { languages: ["typescript", "javascript"], load: () => import("./plugins/javascript/meta.js").then((m) => [m.typescriptMeta, m.javascriptMeta]) },
  { languages: ["csharp"], load: () => import("./plugins/csharp/meta.js").then((m) => [m.csharpMeta]) },
  { languages: ["python"], load: () => import("./plugins/python/meta.js").then((m) => [m.pythonMeta]) },
  { languages: ["java", "kotlin"], load: () => import("./plugins/java-kotlin/meta.js").then((m) => [m.javaMeta, m.kotlinMeta]) },
  { languages: ["pascal", "dfm"], load: () => import("./plugins/pascal/meta.js").then((m) => [m.pascalMeta, m.dfmMeta]) },
  { languages: ["php"], load: () => import("./plugins/php/meta.js").then((m) => [m.phpMeta]) },
  { languages: ["go"], load: () => import("./plugins/go/meta.js").then((m) => [m.goMeta]) },
  { languages: ["rust"], load: () => import("./plugins/rust/meta.js").then((m) => [m.rustMeta]) },
  { languages: ["ruby"], load: () => import("./plugins/ruby/meta.js").then((m) => [m.rubyMeta]) },
  { languages: ["swift"], load: () => import("./plugins/swift/meta.js").then((m) => [m.swiftMeta]) },
  { languages: ["lua"], load: () => import("./plugins/lua/meta.js").then((m) => [m.luaMeta]) },
  { languages: ["scala"], load: () => import("./plugins/scala/meta.js").then((m) => [m.scalaMeta]) },
  { languages: ["perl"], load: () => import("./plugins/perl/meta.js").then((m) => [m.perlMeta]) },
  { languages: ["vb"], load: () => import("./plugins/vb/meta.js").then((m) => [m.vbMeta]) },
  { languages: ["sql"], load: () => import("./plugins/sql/meta.js").then((m) => [m.sqlMeta]) },
  { languages: ["c"], load: () => import("./plugins/c/meta.js").then((m) => [m.cMeta]) },
  { languages: ["cpp"], load: () => import("./plugins/cpp/meta.js").then((m) => [m.cppMeta]) },
  { languages: ["prisma"], load: () => import("./plugins/prisma/meta.js").then((m) => [m.prismaMeta]) },
  { languages: ["dart"], load: () => import("./plugins/dart/meta.js").then((m) => [m.dartMeta]) },
  { languages: ["elixir"], load: () => import("./plugins/elixir/meta.js").then((m) => [m.elixirMeta]) },
  { languages: ["erlang"], load: () => import("./plugins/erlang/meta.js").then((m) => [m.erlangMeta]) },
  { languages: ["objc"], load: () => import("./plugins/objc/meta.js").then((m) => [m.objcMeta]) },
  { languages: ["haskell"], load: () => import("./plugins/haskell/meta.js").then((m) => [m.haskellMeta]) },
  { languages: ["clojure"], load: () => import("./plugins/clojure/meta.js").then((m) => [m.clojureMeta]) },
  { languages: ["blazor"], load: () => import("./plugins/blazor/meta.js").then((m) => [m.blazorMeta]) },
  { languages: ["html"], load: () => import("./plugins/html/meta.js").then((m) => [m.htmlMeta]) },
  { languages: ["erb"], load: () => import("./plugins/erb/meta.js").then((m) => [m.erbMeta]) },
  { languages: ["heex"], load: () => import("./plugins/heex/meta.js").then((m) => [m.heexMeta]) },
  { languages: ["handlebars", "liquid", "velocity", "razor"], load: () => import("./plugins/templates/meta.js").then((m) => [m.handlebarsMeta, m.liquidMeta, m.velocityMeta, m.razorMeta]) },
  { languages: ["qml"], load: () => import("./plugins/qml/meta.js").then((m) => [m.qmlMeta]) },
  { languages: ["qtui"], load: () => import("./plugins/qtui/meta.js").then((m) => [m.qtuiMeta]) },
  { languages: ["xaml"], load: () => import("./plugins/xaml/meta.js").then((m) => [m.xamlMeta]) },
  { languages: ["jsp"], load: () => import("./plugins/jsp/meta.js").then((m) => [m.jspMeta]) },
  { languages: ["springxml"], load: () => import("./plugins/springxml/meta.js").then((m) => [m.springxmlMeta]) },
  { languages: ["jsight"], load: () => import("./plugins/jsight/meta.js").then((m) => [m.jsightMeta]) },
  { languages: ["serverless"], load: () => import("./plugins/serverless/meta.js").then((m) => [m.serverlessMeta]) },
  { languages: ["coredata"], load: () => import("./plugins/coredata/meta.js").then((m) => [m.coredataMeta]) },
  { languages: ["storyboard"], load: () => import("./plugins/storyboard/meta.js").then((m) => [m.storyboardMeta]) },
  { languages: ["terraform"], load: () => import("./plugins/terraform/meta.js").then((m) => [m.terraformMeta]) },
  { languages: ["protobuf"], load: () => import("./plugins/protobuf/meta.js").then((m) => [m.protobufMeta]) },
  { languages: ["openapi"], load: () => import("./plugins/openapi/meta.js").then((m) => [m.openapiMeta]) },
  { languages: ["graphql"], load: () => import("./plugins/graphql/meta.js").then((m) => [m.graphqlMeta]) },
  { languages: ["wsdl"], load: () => import("./plugins/wsdl/meta.js").then((m) => [m.wsdlMeta]) },
  { languages: ["groovy"], load: () => import("./plugins/groovy/meta.js").then((m) => [m.groovyMeta]) },
  { languages: ["powershell"], load: () => import("./plugins/powershell/meta.js").then((m) => [m.powershellMeta]) },
  { languages: ["bash"], load: () => import("./plugins/bash/meta.js").then((m) => [m.bashMeta]) },
  { languages: ["batch"], load: () => import("./plugins/batch/meta.js").then((m) => [m.batchMeta]) },
  { languages: ["fsharp"], load: () => import("./plugins/fsharp/meta.js").then((m) => [m.fsharpMeta]) },
  { languages: ["coffeescript"], load: () => import("./plugins/coffeescript/meta.js").then((m) => [m.coffeeMeta]) },
  { languages: ["r"], load: () => import("./plugins/r/meta.js").then((m) => [m.rMeta]) },
  { languages: ["julia"], load: () => import("./plugins/julia/meta.js").then((m) => [m.juliaMeta]) },
  { languages: ["crystal"], load: () => import("./plugins/crystal/meta.js").then((m) => [m.crystalMeta]) },
  { languages: ["zig"], load: () => import("./plugins/zig/meta.js").then((m) => [m.zigMeta]) },
  { languages: ["ocaml"], load: () => import("./plugins/ocaml/meta.js").then((m) => [m.ocamlMeta]) },
  { languages: ["raku"], load: () => import("./plugins/raku/meta.js").then((m) => [m.rakuMeta]) },
  { languages: ["racket", "scheme", "commonlisp"], load: () => import("./plugins/lisp/meta.js").then((m) => [m.racketMeta, m.schemeMeta, m.commonLispMeta]) },
  { languages: ["haxe"], load: () => import("./plugins/haxe/meta.js").then((m) => [m.haxeMeta]) },
  { languages: ["mojo"], load: () => import("./plugins/mojo/meta.js").then((m) => [m.mojoMeta]) },
  { languages: ["scss", "sass", "less"], load: () => import("./plugins/stylesheet/meta.js").then((m) => [m.scssMeta, m.sassMeta, m.lessMeta]) },
  { languages: ["autohotkey"], load: () => import("./plugins/autohotkey/meta.js").then((m) => [m.autohotkeyMeta]) },
  { languages: ["autoit"], load: () => import("./plugins/autoit/meta.js").then((m) => [m.autoitMeta]) },
  { languages: ["applescript"], load: () => import("./plugins/applescript/meta.js").then((m) => [m.applescriptMeta]) },
  { languages: ["nim"], load: () => import("./plugins/nim/meta.js").then((m) => [m.nimMeta]) },
  { languages: ["dlang"], load: () => import("./plugins/dlang/meta.js").then((m) => [m.dMeta]) },
  { languages: ["vlang"], load: () => import("./plugins/vlang/meta.js").then((m) => [m.vMeta]) },
  { languages: ["fortran"], load: () => import("./plugins/fortran/meta.js").then((m) => [m.fortranMeta]) },
];

const LOADER_BY_LANGUAGE = new Map<Language, PluginLoader>();
for (const loader of LOADERS) {
  for (const lang of loader.languages) LOADER_BY_LANGUAGE.set(lang, loader);
}

/**
 * language → loaders of OTHER plugins whose dispatch resolvers act on it
 * (`manifest.dispatchLanguages`). Requesting "vb" must also load csharp so
 * its UI-bridge resolver runs — matching the eager-registry behavior where
 * every resolver saw every project.
 */
const DISPATCH_COUPLED_LOADERS = new Map<Language, PluginLoader[]>();
for (const manifest of ALL_MANIFESTS) {
  for (const lang of manifest.dispatchLanguages ?? []) {
    const owner = LOADER_BY_LANGUAGE.get(manifest.language);
    if (!owner) continue;
    if (!DISPATCH_COUPLED_LOADERS.has(lang)) DISPATCH_COUPLED_LOADERS.set(lang, []);
    DISPATCH_COUPLED_LOADERS.get(lang)!.push(owner);
  }
}

const BY_LANGUAGE = new Map<Language, LanguagePluginMeta>();
const loadedLoaders = new Set<PluginLoader>();
const inflight = new Map<PluginLoader, Promise<void>>();

/** Fold one just-loaded meta into the per-language lookups and push registrations. */
function registerMeta(meta: LanguagePluginMeta): void {
  BY_LANGUAGE.set(meta.language, meta);
  if (meta.builtinTypes) registerBuiltinTypes(meta.language, meta.builtinTypes);
  registerTransparentTypeWrappers(meta.language, meta.transparentTypeWrappers);
  registerCallPatterns(meta.language, meta.apiCallRoots, meta.dbCallRoots);
  registerCallExtraction(meta.language, meta.calls);
  if (meta.securityRules && meta.securityRules.length > 0) {
    SECURITY_RULES_BY_LANGUAGE.set(meta.language, [...meta.securityRules].sort((a, b) => a.priority - b.priority));
  }
  knownPackagesDirty = true;
}

/**
 * Lazily load the plugin bodies for the given languages (idempotent, safe to
 * call concurrently). Languages without a registered plugin are ignored.
 * Family plugins load all member metas together. Call this after file
 * discovery with the project's language set (plus `ACTIVATION_FILE_LANGUAGES`
 * hits) — every synchronous accessor below assumes the language was loaded.
 */
export async function ensureLanguagesLoaded(languages: Iterable<Language>): Promise<void> {
  const wanted = new Set<PluginLoader>();
  for (const lang of languages) {
    const loader = LOADER_BY_LANGUAGE.get(lang);
    if (loader) wanted.add(loader);
    for (const coupled of DISPATCH_COUPLED_LOADERS.get(lang) ?? []) wanted.add(coupled);
  }

  const pending: Promise<void>[] = [];
  for (const loader of wanted) {
    if (loadedLoaders.has(loader)) continue;
    let p = inflight.get(loader);
    if (!p) {
      p = loader.load().then((metas) => {
        for (const meta of metas) registerMeta(meta);
        loadedLoaders.add(loader);
        inflight.delete(loader);
      });
      inflight.set(loader, p);
    }
    pending.push(p);
  }
  if (pending.length > 0) await Promise.all(pending);
}

/** Load every registered plugin (tests, and tools that can see any language). */
export async function loadAllPlugins(): Promise<void> {
  await ensureLanguagesLoaded(MANIFEST_BY_LANGUAGE.keys());
}

/**
 * Root-level build-manifest filename → languages it activates (`go.mod` → go),
 * aggregated from every plugin manifest's `activationFiles`. The analyzer
 * checks these at the project root and each sub-project root so a plugin's
 * `knownPackages` participate in the dependency inventory even when no source
 * file of the language was discovered.
 */
export const ACTIVATION_FILE_LANGUAGES: ReadonlyMap<string, readonly Language[]> = (() => {
  const map = new Map<string, Language[]>();
  for (const manifest of ALL_MANIFESTS) {
    for (const file of manifest.activationFiles ?? []) {
      if (!map.has(file)) map.set(file, []);
      map.get(file)!.push(manifest.language);
    }
  }
  return map;
})();

/**
 * Extension-less source-file basename → language (`routes` → scala), from
 * every manifest's `namedFiles`. Discovery adds a glob per entry and the
 * language lookup consults it before the extension table.
 */
export const NAMED_FILE_LANGUAGE: ReadonlyMap<string, Language> =
  claimTable(ALL_MANIFESTS, (m) => m.namedFiles ?? [], "Named file");

/** Language → the prefix its partials carry (`_` for Sass). See `LanguagePluginManifest.partialPrefix`. */
export const PARTIAL_PREFIX_BY_LANGUAGE: ReadonlyMap<string, string> = new Map(
  ALL_MANIFESTS.filter((m) => m.partialPrefix).map((m) => [m.language, m.partialPrefix!]),
);

/** Language → its platform infixes (`.ios`, `.android`). See `LanguagePluginManifest.platformSuffixes`. */
export const PLATFORM_SUFFIXES_BY_LANGUAGE: ReadonlyMap<string, readonly string[]> = new Map(
  ALL_MANIFESTS.filter((m) => m.platformSuffixes?.length).map((m) => [m.language, m.platformSuffixes!]),
);

/** Languages that describe an API rather than implement it (see `LanguagePluginManifest.apiContract`). */
const API_CONTRACT_LANGUAGES: ReadonlySet<string> = new Set(
  ALL_MANIFESTS.filter((m) => m.apiContract).map((m) => m.language),
);

export function isApiContractLanguage(language: string): boolean {
  return API_CONTRACT_LANGUAGES.has(language);
}

/** Languages whose imports name package directories (see `LanguagePluginManifest.importsNameDirectories`). */
const DIRECTORY_IMPORT_LANGUAGES: ReadonlySet<string> = new Set(
  ALL_MANIFESTS.filter((m) => m.importsNameDirectories).map((m) => m.language),
);

export function importsNameDirectories(language: string): boolean {
  return DIRECTORY_IMPORT_LANGUAGES.has(language);
}

/** Every manifest's `sourceDirs` (`bin/` beside a `META6.json`, …): skipped directories that are source. */
export const SOURCE_DIRS: ReadonlyArray<{ dir: string; marker: string; markerMatches?: RegExp }> = ALL_MANIFESTS.flatMap((m) => m.sourceDirs ?? []);

/**
 * Languages whose manifest names a family — programming languages, as opposed
 * to the data and markup formats (SQL, OpenAPI, Spring XML, HTML…) that have
 * none. Discovery reads a file of a code language whatever its name says.
 */
export const CODE_LANGUAGES: ReadonlySet<Language> = new Set(ALL_MANIFESTS.filter((m) => m.family).map((m) => m.language));

/**
 * Lowercased key (extension, basename) → the ONE language that claims it. A
 * second claim throws: the later plugin used to win silently, and the
 * earlier one's files vanished from analysis.
 */
export function claimTable(
  manifests: readonly LanguagePluginManifest[],
  keysOf: (manifest: LanguagePluginManifest) => readonly string[],
  what: string,
): Map<string, Language> {
  const map = new Map<string, Language>();
  for (const manifest of manifests) {
    for (const raw of keysOf(manifest)) {
      const key = raw.toLowerCase();
      const owner = map.get(key);
      if (owner) throw new Error(`${what} "${raw}" claimed by both ${owner} and ${manifest.language}`);
      map.set(key, manifest.language);
    }
  }
  return map;
}

/**
 * Meta for a language. Returns undefined for languages with no registered
 * plugin; THROWS for a registered language whose body hasn't been loaded —
 * silently returning undefined there would degrade extraction quietly.
 */
export function pluginFor(language: Language): LanguagePluginMeta | undefined {
  const meta = BY_LANGUAGE.get(language);
  if (!meta && MANIFEST_BY_LANGUAGE.has(language)) {
    throw new Error(
      `Plugin for language "${language}" is not loaded — await ensureLanguagesLoaded([...]) ` +
        `(or loadAllPlugins() in tests) before using extraction paths.`,
    );
  }
  return meta;
}

/**
 * Every LOADED plugin meta, in manifest registration order (stable regardless
 * of load order). Project-level passes iterate this; unloaded plugins have no
 * analyzed files, so their absence is correct.
 */
export function allPluginMetas(): readonly LanguagePluginMeta[] {
  const out: LanguagePluginMeta[] = [];
  for (const manifest of ALL_MANIFESTS) {
    const meta = BY_LANGUAGE.get(manifest.language);
    if (meta) out.push(meta);
  }
  return out;
}

/** AST extractor hooks for a language (undefined when the plugin has none). */
export function astHooksFor(language: Language): AstExtractorHooks | undefined {
  return pluginFor(language)?.ast;
}

/** Complexity tables for a language (undefined when the plugin has none). */
export function complexityFor(language: string): LanguageComplexitySpec | undefined {
  return pluginFor(language as Language)?.complexity;
}

/** Control-flow tables for a language (undefined when the plugin has none). */
export function controlFlowFor(language: string): LanguageControlFlowSpec | undefined {
  return pluginFor(language as Language)?.controlFlow;
}

/** Regex control-flow tables for a language (undefined when the plugin has none). */
export function regexControlFlowFor(language: string): LanguageRegexControlFlowSpec | undefined {
  return pluginFor(language as Language)?.regexControlFlow;
}

/** Regex extraction spec for a language (undefined when the plugin has none). */
export function regexSpecFor(language: Language): RegexLangSpec | undefined {
  return pluginFor(language)?.regexSpec;
}

// ─── Extensions ──────────────────────────────────────────────────────────

/**
 * File extension (with dot) → language, aggregated from every plugin manifest.
 * Keys are lowercase; look up with a lowercased extension — legacy Windows
 * codebases (Delphi, VB) routinely ship `UNIT1.PAS` / `FORM1.DFM` files that
 * a case-sensitive lookup would silently skip. One owner per extension (see
 * `claimTable`).
 */
export const EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>> = Object.fromEntries(
  claimTable(ALL_MANIFESTS, (m) => m.extensions, "Extension"),
);

/**
 * Every registered extension of a language family, in manifest order (`script`
 * → `.ts`, `.tsx`, `.vue`, …, `.coffee`): what a relative import written
 * without an extension may name.
 */
const FAMILY_EXTENSIONS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const manifest of ALL_MANIFESTS) {
    if (!manifest.family) continue;
    const list = map.get(manifest.family) ?? map.set(manifest.family, []).get(manifest.family)!;
    for (const ext of manifest.extensions) if (!list.includes(ext.toLowerCase())) list.push(ext.toLowerCase());
  }
  return map;
})();

export function extensionsOfFamily(family: string | null): readonly string[] {
  return family ? FAMILY_EXTENSIONS.get(family) ?? [] : [];
}

// Push each extension's language family into path-utils (a leaf module plugin
// code imports — it cannot import the registry, see link-scoring below).
registerExtensionFamilies(
  new Map(
    ALL_MANIFESTS.flatMap((manifest) =>
      manifest.family ? manifest.extensions.map((ext) => [ext.slice(1).toLowerCase(), manifest.family!] as const) : [],
    ),
  ),
);

/**
 * Regex that strips a known source-file extension from a path, for building
 * import-resolution path maps. Extensions of `importTarget: false` languages
 * (e.g. .dfm resources) are excluded: stripping them would collide with the
 * code file of the same basename.
 */
export const STRIP_SOURCE_EXTENSION_RE: RegExp = (() => {
  const exts: string[] = [];
  for (const manifest of ALL_MANIFESTS) {
    if (manifest.importTarget === false) continue;
    for (const ext of manifest.extensions) {
      exts.push(ext.slice(1)); // drop the leading dot
    }
  }
  return new RegExp(`\\.(${exts.join("|")})$`, "i");
})();

// ─── Import resolution data ──────────────────────────────────────────────

/** Union of every plugin's external module prefixes (stdlib/package roots). */
export const ALL_EXTERNAL_MODULE_PREFIXES: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const manifest of ALL_MANIFESTS) {
    for (const prefix of manifest.externalModulePrefixes ?? []) {
      if (!seen.has(prefix)) {
        seen.add(prefix);
        out.push(prefix);
      }
    }
  }
  return out;
})();

/**
 * Union of every plugin's builtin member names (`set.add`, `str.toUpperCase`).
 * Calls with these leaves never resolve to project symbols via name-uniqueness
 * heuristics in the symbol linker.
 */
export const ALL_BUILTIN_MEMBERS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const manifest of ALL_MANIFESTS) {
    for (const member of manifest.builtinMembers ?? []) s.add(member);
  }
  return s;
})();

/**
 * Each language's own builtin member names. A heuristic that reads a leaf as
 * "this is a stdlib value, not project code" must ask the CALLER's language:
 * the union lists Python's `login` (smtplib), so a React hook's
 * `const { login } = useAuth()` would read as a stdlib call.
 */
export const BUILTIN_MEMBERS_BY_LANGUAGE: ReadonlyMap<Language, ReadonlySet<string>> = (() => {
  const m = new Map<Language, Set<string>>();
  for (const manifest of ALL_MANIFESTS) {
    if (!manifest.builtinMembers?.length) continue;
    let s = m.get(manifest.language);
    if (!s) m.set(manifest.language, (s = new Set()));
    for (const member of manifest.builtinMembers) s.add(member);
  }
  return m;
})();

/**
 * Matches import sources whose first segment is a well-known external
 * namespace root (e.g. "System.Windows.Forms", "com.example.app") — used to
 * skip directory-name matching for such imports.
 */
export const EXTERNAL_NAMESPACE_ROOT_RE: RegExp = (() => {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const manifest of ALL_MANIFESTS) {
    for (const root of manifest.externalNamespaceRoots ?? []) {
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }
  }
  return new RegExp(`^(${roots.join("|")})\\b`);
})();

// Push the aggregates into link-scoring (it cannot import the registry: it is
// imported by plugin code, and metas are imported by the registry — a static
// import here would close an ESM cycle and TDZ plugin classes).
registerLinkScoringData(ALL_EXTERNAL_MODULE_PREFIXES, STRIP_SOURCE_EXTENSION_RE, PARTIAL_PREFIX_BY_LANGUAGE, PLATFORM_SUFFIXES_BY_LANGUAGE);

// ─── Framework detection rules ───────────────────────────────────────────

/**
 * Manifest-level framework rules from every plugin, in `ALL_MANIFESTS` order
 * (rules within a plugin keep their declaration order). Consumed by
 * `core/framework-detector`, which sorts the *detections* by id so the output
 * never depends on plugin registration order. Rule ids must be globally
 * unique — plugins own disjoint framework domains by design. Static tier:
 * detection always runs over ALL rules, independent of which plugin bodies
 * are loaded.
 */
export const FRAMEWORK_RULES: readonly FrameworkRule[] = (() => {
  const seen = new Set<string>();
  const rules: FrameworkRule[] = [];
  for (const manifest of ALL_MANIFESTS) {
    for (const rule of manifest.frameworkRules ?? []) {
      if (seen.has(rule.id)) {
        throw new Error(`Duplicate framework rule id "${rule.id}" (contributed by ${manifest.language})`);
      }
      seen.add(rule.id);
      rules.push(rule);
    }
  }
  return rules;
})();

/**
 * Union of every plugin's vendored-framework marker paths, checked with a
 * cheap existsSync per project root while building `ProjectInfo.markerFiles`.
 */
export const FRAMEWORK_MARKER_CANDIDATES: readonly string[] = (() => {
  const seen = new Set<string>();
  for (const manifest of ALL_MANIFESTS) {
    for (const marker of manifest.markerCandidates ?? []) seen.add(marker);
  }
  return [...seen];
})();

// ─── Framework hints ─────────────────────────────────────────────────────

/** import source → framework id, aggregated from every plugin manifest. */
const FRAMEWORK_IMPORT_HINTS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const manifest of ALL_MANIFESTS) {
    for (const [source, fwId] of Object.entries(manifest.frameworkImportHints ?? {})) {
      map.set(source, fwId);
    }
  }
  return map;
})();

/**
 * Infer which frameworks a specific file uses, based on its imports.
 * Exact match first; otherwise prefix match (`<hint>/...` or `<hint>....`).
 */
export function inferFileFrameworks(
  imports: { source: string }[],
  filePath: string,
): string[] {
  const fileFrameworks = new Set<string>();

  for (const imp of imports) {
    const exact = FRAMEWORK_IMPORT_HINTS.get(imp.source);
    if (exact) {
      fileFrameworks.add(exact);
      continue;
    }
    for (const [pattern, fwId] of FRAMEWORK_IMPORT_HINTS) {
      if (imp.source.startsWith(pattern + "/") || imp.source.startsWith(pattern + ".")) {
        fileFrameworks.add(fwId);
      }
    }
  }

  // .vue / .svelte files are implicitly Vue / Svelte
  if (filePath.endsWith(".vue")) {
    fileFrameworks.add("vue");
  }
  if (filePath.endsWith(".svelte")) {
    fileFrameworks.add("svelte");
  }

  return [...fileFrameworks];
}

// ─── Package managers ────────────────────────────────────────────────────

/**
 * Every plugin's package managers, in `ALL_MANIFESTS` order — the order the
 * dependency inventory reads their manifests in, which decides which
 * declaration of a package is recorded first. Static tier: every manifest is
 * read whether or not its language was discovered.
 */
export const PACKAGE_MANAGERS: readonly PackageManagerSpec[] = ALL_MANIFESTS.flatMap((m) => m.packageManagers ?? []);

/** Every language's build/test/start reader, in manifest order (the first to name a kind for a root wins). */
export const PROJECT_COMMAND_READERS: ReadonlyArray<NonNullable<LanguagePluginManifest["projectCommands"]>> = ALL_MANIFESTS.flatMap((m) => (m.projectCommands ? [m.projectCommands] : []));

const MATCHING_FIELDS = ["importKey", "packageKey", "prefixMatch", "assertsUnused", "installedOwners"] as const;

/**
 * Per ecosystem, the spec that says how imports match its packages. Several
 * plugins may contribute manifests to one ecosystem (sbt → maven, rebar3 →
 * hex); a second one that also defines matching throws.
 */
const PACKAGE_MATCHING: ReadonlyMap<PackageEcosystem, PackageManagerSpec> = (() => {
  const map = new Map<PackageEcosystem, PackageManagerSpec>();
  for (const spec of PACKAGE_MANAGERS) {
    if (!MATCHING_FIELDS.some((f) => spec[f] !== undefined)) continue;
    if (map.has(spec.ecosystem)) throw new Error(`Package ecosystem "${spec.ecosystem}" has import matching defined twice`);
    map.set(spec.ecosystem, spec);
  }
  return map;
})();

/**
 * Every plugin's configuration-file readers, in `ALL_MANIFESTS` order. Static
 * tier like the package managers: an `appsettings.json` is read at a project
 * root whether or not a `.cs` file was found beside it.
 */
export const CONFIG_SOURCES: readonly ConfigSourceSpec[] = ALL_MANIFESTS.flatMap((m) => m.serviceConfig?.sources ?? []);

/** Every plugin's forwarding-rule readers (dev proxies, gateways), in `ALL_MANIFESTS` order. */
export const PROXY_SOURCES: readonly ProxySourceSpec[] = ALL_MANIFESTS.flatMap((m) => m.serviceConfig?.proxySources ?? []);

/** How a language's programs are configured to reach other services (undefined: the plugin says nothing). */
export function serviceConfigFor(language: string): ServiceConfigSpec | undefined {
  return MANIFEST_BY_LANGUAGE.get(language as Language)?.serviceConfig;
}

/** How imports match the packages of an ecosystem (undefined: they never do — usage stays unknown). */
export function packageMatchingFor(ecosystem: PackageEcosystem): PackageManagerSpec | undefined {
  return PACKAGE_MATCHING.get(ecosystem);
}

/** The package ecosystems a language's imports are matched against. */
export function packageEcosystemsFor(language: Language): readonly PackageEcosystem[] {
  return MANIFEST_BY_LANGUAGE.get(language)?.packageEcosystems ?? [];
}

// ─── Package recognition ─────────────────────────────────────────────────

export interface KnownPackageEntry {
  category: PackageCategory;
  framework?: { id: string; name: string };
}

/**
 * Third-party package classification from every LOADED plugin's
 * `knownPackages` (lazy tier — the analyzer activates ecosystem plugins via
 * source files or `activationFiles` before the dependency inventory runs).
 * Keyed by lowercased package name; framework-bearing rules take precedence
 * over plain-category ones on a collision (two-pass build over the loaded
 * metas in manifest order, so the result is independent of load order).
 */
let knownPackagesDirty = true;
let KNOWN_PACKAGES = new Map<string, KnownPackageEntry>();
let KNOWN_PACKAGE_PATTERNS: Array<{ match: RegExp; entry: KnownPackageEntry }> = [];

function rebuildKnownPackages(): void {
  const exact = new Map<string, KnownPackageEntry>();
  const patterns: Array<{ match: RegExp; entry: KnownPackageEntry }> = [];
  const metas = allPluginMetas();
  // Pass 1: framework-bearing rules win (exact names + family patterns).
  for (const meta of metas) {
    for (const rule of meta.knownPackages ?? []) {
      if (!rule.framework) continue;
      const entry: KnownPackageEntry = { category: rule.category, framework: rule.framework };
      for (const n of rule.names ?? []) exact.set(n.toLowerCase(), entry);
      if (rule.match) patterns.push({ match: rule.match, entry });
    }
  }
  // Pass 2: plain-category rules fill remaining names / patterns.
  for (const meta of metas) {
    for (const rule of meta.knownPackages ?? []) {
      if (rule.framework) continue;
      const entry: KnownPackageEntry = { category: rule.category };
      for (const n of rule.names ?? []) {
        const key = n.toLowerCase();
        if (!exact.has(key)) exact.set(key, entry);
      }
      if (rule.match) patterns.push({ match: rule.match, entry });
    }
  }
  KNOWN_PACKAGES = exact;
  KNOWN_PACKAGE_PATTERNS = patterns;
  knownPackagesDirty = false;
}

/**
 * Classify a package by name: exact plugin hit first, then family patterns
 * (framework-bearing patterns before plain-category ones; first match wins).
 */
export function classifyKnownPackage(name: string): KnownPackageEntry | undefined {
  if (knownPackagesDirty) rebuildKnownPackages();
  const key = name.toLowerCase();
  const exact = KNOWN_PACKAGES.get(key);
  if (exact) return exact;
  for (const p of KNOWN_PACKAGE_PATTERNS) {
    if (p.match.test(key)) return p.entry;
  }
  return undefined;
}

// ─── Security rules ──────────────────────────────────────────────────────

/**
 * Per-language security rules, filled as plugins load (rules are pre-sorted
 * by priority in `registerMeta` so the reported issue order is stable).
 */
const SECURITY_RULES_BY_LANGUAGE = new Map<Language, readonly SecurityRule[]>();

export function securityRulesFor(language: Language): readonly SecurityRule[] {
  return SECURITY_RULES_BY_LANGUAGE.get(language) ?? [];
}

// ─── Test-file patterns ──────────────────────────────────────────────────

/** Language-specific test-file path patterns from every plugin manifest, bucketed per language. */
const TEST_FILE_PATTERNS_BY_LANGUAGE: ReadonlyMap<Language, readonly RegExp[]> = (() => {
  const map = new Map<Language, readonly RegExp[]>();
  for (const manifest of ALL_MANIFESTS) {
    if (manifest.testFilePatterns && manifest.testFilePatterns.length > 0) {
      map.set(manifest.language, manifest.testFilePatterns);
    }
  }
  return map;
})();

export function testFilePatternsFor(language: Language): readonly RegExp[] {
  return TEST_FILE_PATTERNS_BY_LANGUAGE.get(language) ?? [];
}

const GENERATED_FILE_PATTERNS_BY_LANGUAGE: ReadonlyMap<Language, readonly RegExp[]> = (() => {
  const map = new Map<Language, readonly RegExp[]>();
  for (const manifest of ALL_MANIFESTS) {
    if (manifest.generatedFilePatterns && manifest.generatedFilePatterns.length > 0) {
      map.set(manifest.language, manifest.generatedFilePatterns);
    }
  }
  return map;
})();

export function generatedFilePatternsFor(language: Language): readonly RegExp[] {
  return GENERATED_FILE_PATTERNS_BY_LANGUAGE.get(language) ?? [];
}
