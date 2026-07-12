import type { Node, Tree } from "web-tree-sitter";
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
  PackageCategory,
} from "./analysis.js";
import type { ProjectInfo } from "./plugin.js";

/**
 * Framework-detection rule contributed by a language plugin for the ecosystem
 * it owns. Evaluated against the `ProjectInfo` gathered at each project /
 * sub-project root (manifest contents, file-extension sample, marker files) —
 * the core detector stays deliberately generic while plugins own the
 * framework-specific knowledge, exactly like `knownPackages`. Rule ids must be
 * unique across ALL plugins (asserted at registry build time).
 */
export interface FrameworkRule {
  id: string;
  name: string;
  check: (info: ProjectInfo) => boolean;
  /** Human-readable evidence string surfaced in the report ("package.json dependency"). */
  detectedVia: string;
}

/**
 * Package-recognition rule contributed by a language plugin for the package
 * ecosystem it owns (JS→npm, C#→nuget, Go→go modules, …). The core dependency
 * inventory stays deliberately generic — it parses manifests and cross-checks
 * imports without knowing any specific package — while plugins own the
 * package-specific knowledge: which third-party names map to which functional
 * category, and which imply a framework. Matched by exact (case-insensitive)
 * name; the long-tail name-shape heuristics (`@types/*`, `*-eslint-*`, …) live
 * in core. This is the home for ecosystem-specific package handling, alongside
 * the plugin's other subsections (routes/, data-sources/, …).
 */
export interface KnownPackageRule {
  /**
   * Exact package names this rule covers — an npm bare name (`react`), a Maven
   * `group:artifact` or artifactId, a Go module path (`gorm.io/gorm`), a NuGet
   * id (`Microsoft.EntityFrameworkCore`), a Composer `vendor/pkg`, etc.
   * Case-insensitive. Highest priority (an exact hit always wins over `match`).
   */
  names?: readonly string[];
  /**
   * Regex matched against the LOWERCASED package name, for whole families that
   * share a prefix/shape (`spring-boot-*`, `@aws-sdk/*`,
   * `org.apache.logging.log4j:*`). Lower priority than any exact `names` hit, so
   * specific packages can still override their family. Provide `names`, `match`,
   * or both.
   */
  match?: RegExp;
  /** Functional bucket for the report's Dependencies grouping. */
  category: PackageCategory;
  /** When set, matching packages also imply this framework detection. */
  framework?: { id: string; name: string };
}

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
  /**
   * UI screens for tree-sitter languages with designer/markup code embedded in
   * source files (e.g. WinForms `*.Designer.cs`). Regex-path languages use
   * `RegexLangSpec.extractScreens` instead.
   */
  screens?(tree: Tree, sourceText: string, filePath: string): import("./analysis.js").ScreenInfo[];
  /** Rendered sub-components (e.g. JSX <UserTable />). */
  subComponents?(tree: Tree, sourceText: string, imports: ImportInfo[]): SubComponentInfo[];
  /**
   * Nested component tree mirroring the UI's element nesting (React JSX AST,
   * Angular inline templates). Stored on `FileAnalysis.templateTree` and
   * consumed by the screen builder. Vue/Svelte populate this from their SFC
   * preprocess instead.
   */
  componentTree?(tree: Tree, sourceText: string, imports: ImportInfo[]): import("./analysis.js").TemplateComponentNode[];
  /** Component events (e.g. Vue defineEmits / emit calls). */
  events?(sourceText: string): EventInfo[];
  /**
   * Variable → import-source aliases, any scope
   * (`const store = useUserStore()` → store resolves to useUserStore's source).
   * A rich binding also names the FACTORY the variable came from, so a member
   * call whose leaf doesn't exist in the source module (`mutation.mutateAsync`)
   * can fall back to the factory symbol (see CallInfo.via).
   */
  variableAliases?(tree: Tree, imports: ImportInfo[]): Map<string, string | VariableAliasBinding>;
}

/** Rich variable-alias value: the module the binding resolves to + the factory that made it. */
export interface VariableAliasBinding {
  /** Import source of the factory (`../composables/useShopCart`). */
  source: string;
  /** The factory function's name (`useShopCart`). */
  factory?: string;
}

/** Location of a tree-sitter grammar WASM inside an npm package. */
export interface GrammarVariant {
  pkg: string;
  wasm: string;
}

/**
 * Tree-sitter grammar declaration for a language. Registered into
 * `parsers/parser-manager.ts` by the registry (push pattern — parser-manager
 * is imported from plugin base classes, so it can't import the registry).
 */
export interface GrammarSpec {
  /** Grammar variants: key → wasm location. Most languages have exactly one, keyed by the language id. */
  variants: Readonly<Record<string, GrammarVariant>>;
  /** Pick the variant key for a file (e.g. .tsx → "tsx"). Defaults to the language id. */
  keyForFile?(filePath: string): string;
}

/** Result of a container-format preprocess (e.g. Vue SFC → its <script> block). */
export interface PreprocessOutcome {
  /** The source text to parse (e.g. the <script> block). */
  sourceText: string;
  /** The effective language of that source. */
  language: Language;
  /** Run after extraction to merge container data back in (e.g. Vue template elements). */
  postExtract?(analysis: FileAnalysis, rawSource: string): void;
}

/**
 * Call-extraction hooks: everything language-specific about finding and
 * classifying calls. Registered into `shared/call-graph.ts` by the registry
 * (push pattern — call-graph is imported from plugin code, so it can't
 * import the registry itself).
 */
export interface CallExtractionHooks {
  /** AST node types that represent function/method calls in this language. */
  callNodeTypes: ReadonlySet<string>;
  /**
   * Node types that open a nested function/class scope. NOTE: unioned across
   * all plugins — `extractCalls` stops at any registered scope type
   * regardless of language (grammar node names rarely collide, so this
   * matches per-language behavior in practice).
   */
  nestedScopeTypes?: readonly string[];
  /**
   * The subset of nested-scope types that are function EXPRESSIONS (arrow
   * functions, lambdas). When such a node is anonymous — not bound to a name
   * via a variable declarator — `extractCalls` descends into it and attributes
   * its calls to the enclosing function: an inline `onClick={() =>
   * addToCart(id)}` or a `useEffect(() => { fetch(...) })` callback executes
   * on behalf of the function that wires it. Named bindings still stop the
   * walk (they are extracted as their own functions). Unioned across plugins.
   */
  anonymousScopeTypes?: readonly string[];
  /** Call node types whose arguments are scanned for callback identifiers (also unioned). */
  callbackArgNodeTypes?: readonly string[];
  /**
   * Full call-name resolution for this language. Implementations typically
   * delegate to `genericResolveCallName` from shared/call-graph.ts with
   * language-specific options.
   */
  resolveCallName?(node: Node): string | null;
  /**
   * Extra call collection beyond plain call expressions (JSX component
   * references, Python decorators). `resolve` is this language's resolver.
   */
  collectExtraCalls?(
    node: Node,
    addResult: (name: string, node: Node) => void,
    resolve: (node: Node) => string | null,
  ): void;
  /**
   * Classify auto-imported globals before import lookup (e.g. Vue compiler
   * macros). Return the cross-file target, or null to fall through.
   */
  classifyAutoImported?(callName: string): { target: string } | null;
  /**
   * Alternate import-map keys to try for a qualified call's root, in order
   * (e.g. Java `userService` → `UserService`). Matches classify as INFERRED.
   */
  qualifiedRootCandidates?(root: string): readonly string[];
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
  /**
   * Language-specific filename/path patterns that mark a file as a test
   * (unit, integration, or e2e) — e.g. Go `_test.go`, JS `*_spec.js`/`*.cy.ts`,
   * Python `test_*.py`. Matched against the project-relative path (both `/` and
   * `\` separators). Cross-language conventions (`__tests__/`, `*.test.*`,
   * `tests/`, `cypress/`) are handled generically in `core/test-file-detector`,
   * so a plugin only declares what's idiomatic to its language. Test files are
   * excluded from route extraction (see `extractRoutes` callers).
   */
  testFilePatterns?: readonly RegExp[];
  /** Parser for `parsing: "custom"` formats (e.g. .dfm). */
  customParse?(rawSource: string, relativePath: string): FileAnalysis;
  /** Tree-sitter grammar location(s) for `parsing: "tree-sitter"` languages. */
  grammar?: GrammarSpec;
  /** Regex extraction spec for `parsing: "regex"` languages (and tree-sitter parse-failure fallback). */
  regexSpec?: import("../extractors/plugins/shared/regex-base.js").RegexLangSpec;
  /**
   * Container-format preprocessing (e.g. Vue SFC): swap in the embedded
   * source/language before parsing, or skip the file entirely.
   * Return null to proceed with the file as-is.
   */
  preprocess?(rawSource: string, relativePath: string): PreprocessOutcome | { skip: string } | null;

  /** Builtin/stdlib type names — never tracked as project type references. */
  builtinTypes?: ReadonlySet<string>;
  /**
   * Builtin member/method names (`set.add`, `str.toUpperCase`) — a call whose
   * leaf is one of these never resolves to a project symbol by name-uniqueness
   * heuristics (a project method merely sharing the name is a coincidence).
   */
  builtinMembers?: readonly string[];
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

  /**
   * Third-party packages this language's ecosystem owns — drives the dependency
   * inventory's categorisation and framework derivation. Aggregated globally by
   * the registry (frameworks win over plain categories on a name collision).
   */
  knownPackages?: readonly KnownPackageRule[];
  /**
   * Manifest-level framework rules for this plugin's ecosystem, evaluated per
   * project root by `core/framework-detector`. Family plugins (javascript,
   * java-kotlin, pascal) attach rules to ONE member meta only, so the registry
   * aggregates each rule exactly once.
   */
  frameworkRules?: readonly FrameworkRule[];
  /**
   * Well-known relative paths whose existence at a project root identifies a
   * vendored framework that no manifest records (e.g. CodeIgniter 2/3's
   * `system/` tree). Collected into `ProjectInfo.markerFiles` with a cheap
   * existsSync per candidate; rules then match on membership.
   */
  markerCandidates?: readonly string[];
  /** import source (exact, or prefix-matched with "/" or ".") → framework id. */
  frameworkImportHints?: Readonly<Record<string, string>>;
  /** Call roots that indicate an HTTP/API client (call-graph classification). */
  apiCallRoots?: readonly string[];
  /** Call roots that indicate a database/ORM object (call-graph classification). */
  dbCallRoots?: readonly string[];

  /** AST/source-level extractor hooks. */
  ast?: AstExtractorHooks;
  /** Call extraction/classification hooks (see shared/call-graph.ts). */
  calls?: CallExtractionHooks;
}
