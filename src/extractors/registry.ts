import type { Language, PackageCategory } from "../types/analysis.js";
import type { LanguagePluginMeta, LanguageComplexitySpec, SecurityRule, AstExtractorHooks } from "../types/language-plugin.js";
import type { RegexLangSpec } from "./plugins/shared/regex-base.js";
import { registerBuiltinTypes } from "./shared/builtin-types.js";
import { registerCallPatterns } from "./shared/call-patterns.js";
import { registerCallExtraction } from "./shared/call-graph.js";
import { registerGrammar } from "../parsers/parser-manager.js";

import { typescriptMeta, javascriptMeta } from "./plugins/javascript/meta.js";
import { csharpMeta } from "./plugins/csharp/meta.js";
import { pythonMeta } from "./plugins/python/meta.js";
import { javaMeta, kotlinMeta } from "./plugins/java-kotlin/meta.js";
import { pascalMeta, dfmMeta } from "./plugins/pascal/meta.js";
import { phpMeta } from "./plugins/php/meta.js";
import { goMeta } from "./plugins/go/meta.js";
import { rustMeta } from "./plugins/rust/meta.js";
import { rubyMeta } from "./plugins/ruby/meta.js";
import { swiftMeta } from "./plugins/swift/meta.js";
import { luaMeta } from "./plugins/lua/meta.js";
import { scalaMeta } from "./plugins/scala/meta.js";
import { perlMeta } from "./plugins/perl/meta.js";
import { vbMeta } from "./plugins/vb/meta.js";
import { sqlMeta } from "./plugins/sql/meta.js";
import { cMeta } from "./plugins/c/meta.js";
import { cppMeta } from "./plugins/cpp/meta.js";
import { prismaMeta } from "./plugins/prisma/meta.js";
import { dartMeta } from "./plugins/dart/meta.js";
import { elixirMeta } from "./plugins/elixir/meta.js";
import { erlangMeta } from "./plugins/erlang/meta.js";
import { objcMeta } from "./plugins/objc/meta.js";
import { haskellMeta } from "./plugins/haskell/meta.js";
import { clojureMeta } from "./plugins/clojure/meta.js";
import { blazorMeta } from "./plugins/blazor/meta.js";
import { htmlMeta } from "./plugins/html/meta.js";

/**
 * The language plugin registry. Aggregates every plugin's LanguagePluginMeta
 * into the lookup structures the (language-agnostic) core consumes. Adding a
 * language = create `plugins/<lang>/meta.ts` and list it here.
 */
const ALL_METAS: LanguagePluginMeta[] = [
  typescriptMeta, javascriptMeta,
  csharpMeta, pythonMeta,
  javaMeta, kotlinMeta,
  pascalMeta, dfmMeta,
  phpMeta,
  goMeta, rustMeta, rubyMeta, swiftMeta, luaMeta, scalaMeta, perlMeta,
  vbMeta, sqlMeta, cMeta, cppMeta, prismaMeta, dartMeta, elixirMeta, erlangMeta, objcMeta,
  haskellMeta, clojureMeta, blazorMeta, htmlMeta,
];

const BY_LANGUAGE = new Map<Language, LanguagePluginMeta>();
for (const meta of ALL_METAS) {
  BY_LANGUAGE.set(meta.language, meta);
  if (meta.builtinTypes) registerBuiltinTypes(meta.language, meta.builtinTypes);
  registerCallPatterns(meta.language, meta.apiCallRoots, meta.dbCallRoots);
  registerCallExtraction(meta.language, meta.calls);
  registerGrammar(meta.language, meta.grammar);
}

/** Meta for a language, or undefined for unregistered languages. */
export function pluginFor(language: Language): LanguagePluginMeta | undefined {
  return BY_LANGUAGE.get(language);
}

/** AST extractor hooks for a language (undefined when the plugin has none). */
export function astHooksFor(language: Language): AstExtractorHooks | undefined {
  return BY_LANGUAGE.get(language)?.ast;
}

/** Complexity tables for a language (undefined when the plugin has none). */
export function complexityFor(language: string): LanguageComplexitySpec | undefined {
  return BY_LANGUAGE.get(language as Language)?.complexity;
}

/**
 * Default complexity tables for languages that haven't declared their own —
 * C-family branch/operator names, which most grammars share.
 */
export const DEFAULT_COMPLEXITY: LanguageComplexitySpec = (() => {
  const spec = BY_LANGUAGE.get("typescript")?.complexity;
  if (!spec) throw new Error("typescript plugin must declare complexity tables (used as the default)");
  return spec;
})();

/** Regex extraction spec for a language (undefined when the plugin has none). */
export function regexSpecFor(language: Language): RegexLangSpec | undefined {
  return BY_LANGUAGE.get(language)?.regexSpec;
}

// ─── Extensions ──────────────────────────────────────────────────────────

/** File extension (with dot) → language, aggregated from every plugin. */
export const EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>> = (() => {
  const map: Record<string, Language> = {};
  for (const meta of ALL_METAS) {
    for (const ext of meta.extensions) {
      map[ext] = meta.language;
    }
  }
  return map;
})();

/**
 * Regex that strips a known source-file extension from a path, for building
 * import-resolution path maps. Extensions of `importTarget: false` languages
 * (e.g. .dfm resources) are excluded: stripping them would collide with the
 * code file of the same basename.
 */
export const STRIP_SOURCE_EXTENSION_RE: RegExp = (() => {
  const exts: string[] = [];
  for (const meta of ALL_METAS) {
    if (meta.importTarget === false) continue;
    for (const ext of meta.extensions) {
      exts.push(ext.slice(1)); // drop the leading dot
    }
  }
  return new RegExp(`\\.(${exts.join("|")})$`);
})();

// ─── Import resolution data ──────────────────────────────────────────────

/** Union of every plugin's external module prefixes (stdlib/package roots). */
export const ALL_EXTERNAL_MODULE_PREFIXES: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const meta of ALL_METAS) {
    for (const prefix of meta.externalModulePrefixes ?? []) {
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
  for (const meta of ALL_METAS) {
    for (const member of meta.builtinMembers ?? []) s.add(member);
  }
  return s;
})();

/**
 * Matches import sources whose first segment is a well-known external
 * namespace root (e.g. "System.Windows.Forms", "com.example.app") — used to
 * skip directory-name matching for such imports.
 */
export const EXTERNAL_NAMESPACE_ROOT_RE: RegExp = (() => {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const meta of ALL_METAS) {
    for (const root of meta.externalNamespaceRoots ?? []) {
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }
  }
  return new RegExp(`^(${roots.join("|")})\\b`);
})();

// ─── Framework hints ─────────────────────────────────────────────────────

/** import source → framework id, aggregated from every plugin. */
const FRAMEWORK_IMPORT_HINTS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const meta of ALL_METAS) {
    for (const [source, fwId] of Object.entries(meta.frameworkImportHints ?? {})) {
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

// ─── Package recognition ─────────────────────────────────────────────────

export interface KnownPackageEntry {
  category: PackageCategory;
  framework?: { id: string; name: string };
}

/**
 * Aggregated third-party package classification from every plugin's
 * `knownPackages`. Keyed by lowercased package name; framework-bearing rules
 * take precedence over plain-category ones on a collision (two-pass build), so
 * the core dependency inventory needs no hardcoded package knowledge of its own.
 */
const { KNOWN_PACKAGES, KNOWN_PACKAGE_PATTERNS } = (() => {
  const exact = new Map<string, KnownPackageEntry>();
  const patterns: Array<{ match: RegExp; entry: KnownPackageEntry }> = [];
  // Pass 1: framework-bearing rules win (exact names + family patterns).
  for (const meta of ALL_METAS) {
    for (const rule of meta.knownPackages ?? []) {
      if (!rule.framework) continue;
      const entry: KnownPackageEntry = { category: rule.category, framework: rule.framework };
      for (const n of rule.names ?? []) exact.set(n.toLowerCase(), entry);
      if (rule.match) patterns.push({ match: rule.match, entry });
    }
  }
  // Pass 2: plain-category rules fill remaining names / patterns.
  for (const meta of ALL_METAS) {
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
  return { KNOWN_PACKAGES: exact, KNOWN_PACKAGE_PATTERNS: patterns };
})();

/**
 * Classify a package by name: exact plugin hit first, then family patterns
 * (framework-bearing patterns before plain-category ones; first match wins).
 */
export function classifyKnownPackage(name: string): KnownPackageEntry | undefined {
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
 * Per-language security rules from every plugin, sorted by priority so the
 * scan (and therefore the reported issue order) is independent of plugin
 * registration order. Rules are pre-bucketed per language.
 */
const SECURITY_RULES_BY_LANGUAGE: ReadonlyMap<Language, readonly SecurityRule[]> = (() => {
  const map = new Map<Language, SecurityRule[]>();
  for (const meta of ALL_METAS) {
    if (!meta.securityRules || meta.securityRules.length === 0) continue;
    map.set(meta.language, [...meta.securityRules].sort((a, b) => a.priority - b.priority));
  }
  return map;
})();

export function securityRulesFor(language: Language): readonly SecurityRule[] {
  return SECURITY_RULES_BY_LANGUAGE.get(language) ?? [];
}

// ─── Test-file patterns ──────────────────────────────────────────────────

/** Language-specific test-file path patterns from every plugin, bucketed per language. */
const TEST_FILE_PATTERNS_BY_LANGUAGE: ReadonlyMap<Language, readonly RegExp[]> = (() => {
  const map = new Map<Language, readonly RegExp[]>();
  for (const meta of ALL_METAS) {
    if (meta.testFilePatterns && meta.testFilePatterns.length > 0) {
      map.set(meta.language, meta.testFilePatterns);
    }
  }
  return map;
})();

export function testFilePatternsFor(language: Language): readonly RegExp[] {
  return TEST_FILE_PATTERNS_BY_LANGUAGE.get(language) ?? [];
}
