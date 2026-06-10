import type { Tree } from "web-tree-sitter";
import type {
  Language,
  SecurityCategory,
  SecuritySeverity,
  SecurityIssue,
  TypeReference,
  InteractiveElementInfo,
  SubComponentInfo,
  EventInfo,
  ImportInfo,
  FileAnalysis,
} from "./analysis.js";

/**
 * A regex security rule. Contributed by language plugins (language-specific
 * rules) or by the scanner itself (generic rules that apply to every
 * language).
 */
export interface SecurityRule {
  category: SecurityCategory;
  severity: SecuritySeverity;
  pattern: RegExp;
  message: string;
  /**
   * Evaluation order across ALL rules (generic + every plugin) — lower runs
   * first. This is observable: issues are reported in rule order, so the
   * order must be stable regardless of plugin registration order.
   */
  priority: number;
  /** Skip this rule in test files. */
  excludeTest?: boolean;
}

/** Node types / operators that count toward cyclomatic complexity. */
export interface LanguageComplexitySpec {
  branchNodes: ReadonlySet<string>;
  logicalOps: ReadonlySet<string>;
}

/**
 * Optional AST/source-level extractor hooks for tree-sitter languages.
 * A language without a hook simply contributes nothing for that field —
 * exactly like the old shared extractors that returned [] for languages
 * they didn't understand.
 */
export interface AstExtractorHooks {
  /** Type-position references from the raw AST (params, casts, new-expressions). */
  typeReferences?(tree: Tree, filePath: string): TypeReference[];
  /** Interactive UI elements (buttons, inputs with handlers) from the AST. */
  interactiveElements?(tree: Tree, sourceText: string): InteractiveElementInfo[];
  /** Interactive elements from a template block (Vue SFC <template>). */
  templateInteractiveElements?(template: string, rawSource: string): InteractiveElementInfo[];
  /** Rendered sub-components (e.g. JSX <UserTable />). */
  subComponents?(tree: Tree, sourceText: string, imports: ImportInfo[]): SubComponentInfo[];
  /** Component events (e.g. Vue defineEmits / emit calls). */
  events?(sourceText: string): EventInfo[];
}

/**
 * Per-language plugin metadata: everything the pipeline needs to know about
 * a language that isn't one of the five domain extractors (imports/exports,
 * functions/classes, routes, data sources, data mutations — those have their
 * own registries). One meta per Language; a plugin directory that covers a
 * language family (java-kotlin, javascript) exports one meta per member.
 *
 * Metas must stay leaf modules: import types, their own plugin code, and
 * shared leaf helpers only — never core or the registry.
 */
export interface LanguagePluginMeta {
  language: Language;
  /** How files of this language are parsed. */
  parsing: "tree-sitter" | "regex" | "custom";
  /** File extensions (with leading dot) owned by this language. */
  extensions: readonly string[];
  /**
   * Whether import resolution should treat files of this language as
   * resolvable targets (extension stripped when building path maps).
   * False for resource formats like Delphi .dfm that share basenames with
   * their code counterpart and are never imported by name. Default: true.
   */
  importTarget?: boolean;
  /** Parser for `parsing: "custom"` formats (e.g. .dfm). */
  customParse?(rawSource: string, relativePath: string): FileAnalysis;

  /** Builtin/stdlib type names — never tracked as project type references. */
  builtinTypes?: ReadonlySet<string>;
  /**
   * stdlib / well-known package prefixes: an import source equal to a prefix,
   * or starting with `<prefix>.` or `<prefix>/`, never resolves to a project file.
   */
  externalModulePrefixes?: readonly string[];
  /**
   * Namespace roots (first path segment) that mark an import as external for
   * directory-import resolution (e.g. "System", "java", "com").
   */
  externalNamespaceRoots?: readonly string[];
  /** Cyclomatic-complexity counting tables. */
  complexity?: LanguageComplexitySpec;

  /** Language-specific security rules (see SecurityRule.priority). */
  securityRules?: readonly SecurityRule[];
  /** Pre-filter applied to source before security regexes run (e.g. strip Python strings/comments). */
  securityPreprocess?(sourceText: string): string;
  /** Extra whole-file checks run after the regex rules (e.g. console.log counting). */
  securityPostScan?(lines: string[], filePath: string): SecurityIssue[];
  /** Skip security scanning entirely (resource formats). */
  skipSecurityScan?: boolean;

  /** import source (exact, or prefix-matched with "/" or ".") → framework id. */
  frameworkImportHints?: Readonly<Record<string, string>>;
  /** Call roots that indicate an HTTP/API client (call-graph classification). */
  apiCallRoots?: readonly string[];
  /** Call roots that indicate a database/ORM object (call-graph classification). */
  dbCallRoots?: readonly string[];

  /** AST/source-level extractor hooks. */
  ast?: AstExtractorHooks;
}
