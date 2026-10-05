import type { Node, Tree } from "web-tree-sitter";
import type {
  Language,
  SecurityCategory,
  SecuritySeverity,
  SecurityIssue,
  TypeReference,
  InteractiveElementInfo,
  SubComponentInfo,
  CustomElementDef,
  EventInfo,
  ImportInfo,
  FileAnalysis,
  PackageCategory,
} from "./analysis.js";
import type { ProjectInfo } from "./plugin.js";
import type { RouteExtractor } from "../extractors/routes/base.js";
import type { DataSourceExtractor } from "../extractors/data-sources/base.js";
import type { DataMutationExtractor } from "../extractors/data-mutations/base.js";
import type { EntityExtractor } from "../extractors/entities/base.js";
import type { FunctionClassExtractor } from "../extractors/functions-classes/base.js";
import type { ImportExportExtractor } from "../extractors/imports-exports/base.js";
import type { DispatchResolver } from "../extractors/dispatch/base.js";

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
  /** Node types that open a branch: +1 cyclomatic, +1 plus nesting depth cognitive. */
  branchNodes: ReadonlySet<string>;
  /** Operator texts (`&&`, `or`, …) that count as a branch when they appear in a binary expression. */
  logicalOps: ReadonlySet<string>;
  /**
   * Node types that deepen nesting for the cognitive metric WITHOUT being a
   * branch themselves — nested functions, lambdas, closures. A branch inside a
   * callback is harder to follow than the same branch inline, so it pays the
   * extra depth. Branch nodes always deepen nesting; this set is optional.
   */
  nestingNodes?: ReadonlySet<string>;
}

/**
 * What a node type does to control flow. The shared CFG builder
 * (`core/control-flow.ts`) is a structured-statement interpreter; a role is
 * all it needs from a language to know how to sequence a node, because every
 * language it targets is structured the same way underneath.
 */
export type ControlFlowRole =
  /** Holds a statement sequence (`statement_block`, `block`). */
  | "block"
  /** Two-way branch on a condition (`if_statement`). */
  | "branch"
  /** Pre-test loop — condition runs before the body (`while`, `for`, `foreach`). */
  | "loop"
  /** Post-test loop — body runs at least once (`do … while`). */
  | "post-test-loop"
  /** Multi-way branch (`switch_statement`). */
  | "switch"
  /** One arm of a switch (`switch_case`, `switch_section`, `switch_default`). */
  | "case"
  /** A label within an arm, as opposed to the arm's statements (`constant_pattern`). */
  | "case-label"
  /** Guarded region (`try_statement`). */
  | "try"
  | "catch"
  | "finally"
  | "return"
  | "throw"
  | "break"
  | "continue"
  /** A labelled statement, for `break`/`continue` with a target. */
  | "label"
  /**
   * A node whose body is entered unconditionally — `else_clause`, `using`,
   * `lock`. The builder descends into it and draws nothing of its own.
   */
  | "wrapper"
  /** Opens a nested function; the CFG stops here rather than inlining it. */
  | "nested-function"
  /** Not control flow at all — comments. Skipped rather than drawn. */
  | "ignore"
  /**
   * A jump whose kind is written in its keyword rather than its node type.
   * Kotlin has one `jump_expression` for `return`, `break`, `continue` and
   * `throw`; `jumpRoles` says which is which.
   */
  | "jump";

/** Which part of a node the builder is asking for. */
export type ControlFlowField =
  | "condition"
  | "consequence"
  | "alternative"
  | "body"
  | "update"
  | "initializer"
  | "value"
  | "label"
  /** The `finally` region, for grammars that mark it with a field. */
  | "finalizer";

/**
 * Per-language control-flow tables, the CFG counterpart of
 * `LanguageComplexitySpec`. Grammars for C-family languages agree on the field
 * names for the parts that matter (`condition` / `consequence` / `alternative`
 * / `body`), so a language usually contributes only `roles`; `fields` exists
 * for the handful that spell a part differently (C# says `update` where
 * TypeScript says `increment`).
 */
export interface LanguageControlFlowSpec {
  /** Tree-sitter node type → the role it plays in control flow. */
  roles: ReadonlyMap<string, ControlFlowRole>;
  /**
   * Field-name candidates per part, tried in order, merged over the defaults
   * in `shared/control-flow-defaults.ts`. A language only lists the parts it
   * spells differently.
   */
  fields?: Partial<Record<ControlFlowField, readonly string[]>>;
  /**
   * Whether a switch arm runs on into the next one when nothing jumps out.
   * True for the C family (`switch`), false for Python's `match` and Kotlin's
   * `when`, where each arm leaves the construct on its own. Defaults to true.
   */
  fallthrough?: boolean;
  /**
   * Arm labels that mean "everything else", matched against the arm's label
   * text. An arm with no label at all is already treated as the default; this
   * is for the grammars that spell the catch-all as a label of its own —
   * Java's `default:`, Python's `case _:`, Kotlin's `else ->`. Without it the
   * switch is drawn with an extra unmatched-value edge past a construct that
   * in fact always matches. Defaults to the list in
   * `shared/control-flow-defaults.ts`.
   */
  wildcardLabels?: readonly string[];
  /**
   * Positional fallback for grammars that name no fields.
   * `{ if_expression: { condition: 0, consequence: 1, alternative: 2 } }` reads
   * "the condition is the first named child, …". A negative index counts from
   * the end, so `-1` is "the last named child". Consulted only when no field
   * name matched, so a grammar that names its parts is unaffected.
   *
   * tree-sitter-kotlin is the reason this exists: it labels nothing, so
   * without positions an `if`'s branches cannot be told apart from its
   * condition and the whole body would go undrawn.
   */
  shapes?: Readonly<Record<string, Partial<Record<ControlFlowField, number>>>>;
  /**
   * For the `jump` role: leading keyword → the role it really plays.
   * `{ return: "return", break: "break", continue: "continue", throw: "throw" }`.
   */
  jumpRoles?: Readonly<Record<string, ControlFlowRole>>;
  /**
   * Node types matching this are skipped rather than drawn, on top of the
   * `ignore` role. For grammars that make keywords named nodes: Pascal has 155
   * of them (`kBegin`, `kEnd`, `kThen`, …) and they sit in statement position,
   * so listing each one would be the whole table.
   */
  ignorePattern?: RegExp;
}

/**
 * Control-flow tables for a language with no parser.
 *
 * The counterpart of `LanguageControlFlowSpec` for the regex tier: where that
 * one maps a grammar's node types to roles, this one recognises constructs in
 * the source text and says how the language delimits a block. The scanner then
 * synthesizes nodes carrying the SAME canonical types (`if_statement`,
 * `while_statement`, …) and hands them to the same interpreter, so a language
 * here needs no second builder — only a vocabulary.
 *
 * Almost every language can start from `BRACE_REGEX_CONTROL_FLOW` in
 * `shared/control-flow-defaults.ts` and override the few lines it spells
 * differently.
 */
export interface LanguageRegexControlFlowSpec {
  /**
   * Statement patterns, tried in order against each trimmed line. The first
   * capture group, when there is one, is the controlling expression and
   * becomes the node's label. `type` must be a canonical type the shared role
   * table names.
   */
  statements: readonly { match: RegExp; type: string }[];
  /** Token(s) that open a nesting level. Default `{`. */
  blockOpen?: RegExp;
  /** Token(s) that close one. Default `}`. */
  blockClose?: RegExp;
  /** Line-comment introducers, blanked before anything is matched. Default `//`. */
  lineComments?: readonly string[];
  /** Block-comment delimiters. Default `/* … *\/`. */
  blockComment?: readonly [string, string];
  /** String delimiters, blanked so a brace inside one cannot move the nesting. */
  quotes?: readonly string[];
  /** Whether a string may span lines (Python, Ruby heredocs, Go backticks). */
  multilineStrings?: boolean;
  /** `else if` / `elsif` / `elif`, capturing the condition. */
  elseIf?: RegExp;
  /** A bare `else`. */
  else?: RegExp;
  /** `catch` / `rescue` / `except`. */
  catch?: RegExp;
  /** `finally` / `ensure`. */
  finally?: RegExp;
  /** A switch arm label, capturing the matched value (absent capture = default). */
  case?: RegExp;
  /**
   * Blank regular-expression literals as well as strings. Only for languages
   * that have them as a literal form (JavaScript, TypeScript): `/\}\{/` holds
   * braces that would otherwise move the nesting, and this repo's own source
   * has enough of them to be the largest remaining source of error.
   */
  regexLiterals?: boolean;
  /**
   * Lines that open a nested function or closure. The scan draws the whole
   * block as one step rather than descending, matching where the tree-sitter
   * tier stops. Defaults to a broad C-family pattern.
   */
  nestedFunction?: RegExp;
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
   * For a component that references an EXTERNAL template file rather than an
   * inline one (Angular `templateUrl: './x.html'`) — the raw url string, so a
   * project-level pass can read the sibling file and back-fill the component's
   * template-derived data. Null when the file has an inline template or none.
   */
  externalTemplate?(sourceText: string): string | null;
  /**
   * Custom-element (Web Component) registrations in the file
   * (`customElements.define("x-y", Cls)`, Lit `@customElement("x-y")`), so the
   * component graph can join `<x-y>` markup usages to the defining file.
   */
  customElements?(sourceText: string): CustomElementDef[];
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
   * Where this grammar binds a name locally, so the callback-argument scan can
   * tell a function passed by reference (`items.map(formatUser)`) from a
   * value passed by name (`save(user)`, `repo.find(user_id)`): an identifier
   * the function binds itself — a parameter, a declarator, an assignment
   * target, a loop or catch variable — names a value, never a definition the
   * linker could reach, and is not recorded as a call. Without this every
   * such argument became a "call" that the linker then resolved by name or
   * through a factory alias to an unrelated function.
   *
   * Node type → the fields holding the bound pattern: the parameter list of
   * a function-like node (`arrow_function` → `parameter`, `parameters`),
   * `variable_declarator` → `name`, Python `assignment` → `left`. Unioned
   * across plugins.
   */
  bindingSites?: Readonly<Record<string, readonly string[]>>;
  /**
   * How to read the names out of a bound pattern: pattern node type → the
   * fields that hold further bound names, or `"*"` for every named child
   * (`object_pattern` → `*`, `pair_pattern` → `value`, `default_parameter` →
   * `name`). Identifiers and shorthand pattern identifiers are the leaves;
   * any other node in a bound position — `obj.x = …`, a type annotation, a
   * default value — binds nothing. Unioned across plugins.
   */
  bindingPatterns?: Readonly<Record<string, readonly string[]>>;
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
 * The STATIC tier of a language plugin — the cheap pure data the registry
 * aggregates eagerly for every plugin, before (and without) loading any plugin
 * body: file-extension ownership, grammar locations, framework-detection
 * rules, import-resolution string lists. Lives in `plugins/<dir>/manifest.ts`,
 * which must stay a leaf module importing only types and the plugin's
 * `frameworks.ts`. Everything heavy (extractors, regex specs, AST hooks)
 * belongs on `LanguagePluginMeta`, whose module is loaded lazily per language
 * via `ensureLanguagesLoaded`.
 */
export interface LanguagePluginManifest {
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
  /** Tree-sitter grammar location(s) for `parsing: "tree-sitter"` languages. */
  grammar?: GrammarSpec;
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
  /**
   * Language-idiomatic GENERATED-file conventions: `*.Designer.cs`, `*.g.cs`,
   * `*.pb.go`, `*_pb2.py`, `*.freezed.dart`. Matched against the
   * project-relative path.
   *
   * Generated-code detection is otherwise directory-based (barrel trees,
   * `generated/`, `vendor/`) plus whatever a team writes into its config, so a
   * codegen convention that names FILES rather than folders was invisible and
   * its output counted against the team's quality signals.
   *
   * A match does NOT stop the file being analyzed — its screens, routes and
   * entities are real facts, and a WinForms `*.Designer.cs` is the only place a
   * form's layout exists. It excludes the file from the quality signals
   * (patterns, duplicates, layer violations, refactor pressure, the health
   * grade), which is what a team neither writes nor maintains should be
   * excluded from.
   */
  generatedFilePatterns?: readonly RegExp[];
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
  /** import source (exact, or prefix-matched with "/" or ".") → framework id. */
  frameworkImportHints?: Readonly<Record<string, string>>;
  /**
   * Manifest-level framework rules for this plugin's ecosystem, evaluated per
   * project root by `core/framework-detector`. Family plugins (javascript,
   * java-kotlin, pascal) attach rules to ONE member manifest only, so the
   * registry aggregates each rule exactly once.
   */
  frameworkRules?: readonly FrameworkRule[];
  /**
   * Well-known relative paths whose existence at a project root identifies a
   * vendored framework that no manifest records (e.g. CodeIgniter 2/3's
   * `system/` tree). Collected into `ProjectInfo.markerFiles` with a cheap
   * existsSync per candidate; rules then match on membership.
   */
  markerCandidates?: readonly string[];
  /**
   * Root-level build-manifest filenames whose presence at the project root or
   * a sub-project root activates (lazy-loads) this plugin even when no source
   * file of the language was discovered — e.g. `go.mod` activates go so its
   * `knownPackages` can classify the dependency inventory.
   */
  activationFiles?: readonly string[];
  /**
   * Extension-less SOURCE files this language owns, by basename — Play's
   * `conf/routes`. Discovery globs by extension, so without this such a file
   * is never analysed; the registry maps the basename to the language and
   * `getLanguageForFile` checks it before the extension.
   */
  namedFiles?: readonly string[];
  /**
   * OTHER languages this plugin's `dispatchResolvers` act on (beyond its own).
   * Discovering any of them lazy-loads this plugin too, so a cross-language
   * resolver still runs when its owner's language is absent — e.g. csharp's
   * UI-bridge resolver joins VB/XAML code-behind in a pure-VB MAUI project.
   */
  dispatchLanguages?: readonly Language[];
}

/**
 * Per-language plugin metadata — the LAZY tier: everything the static
 * manifest doesn't carry (domain extractors, regex specs, AST/call hooks,
 * security rules, package knowledge). One meta per Language; a plugin
 * directory that covers a language family (java-kotlin, javascript) exports
 * one meta per member, each spreading its manifest so the static fields have
 * a single source of truth.
 *
 * Metas must stay leaf modules: import types, their own plugin code, and
 * shared leaf helpers only — never core or the registry.
 */
export interface LanguagePluginMeta extends LanguagePluginManifest {
  /** Parser for `parsing: "custom"` formats (e.g. .dfm). */
  customParse?(rawSource: string, relativePath: string): FileAnalysis;
  /**
   * Encoding used to read the file from disk (default "utf-8"). Formats that
   * can be BINARY (Delphi .dfm TPF0 streams) use "latin1" so every byte
   * survives round-tripping through the string (charCodeAt(i) === byte i) —
   * a utf-8 decode would collapse invalid sequences into U+FFFD.
   */
  sourceEncoding?: "utf-8" | "latin1";
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
  /** Cyclomatic-complexity counting tables. */
  complexity?: LanguageComplexitySpec;
  /**
   * Control-flow role tables for the on-demand CFG (`clarifydoc cfg`). Absent
   * means the language has no control-flow view — the complexity number still
   * works, it just cannot be explained graphically.
   */
  controlFlow?: LanguageControlFlowSpec;
  /**
   * Control-flow tables for the regex tier — how this language's constructs
   * look in source text, for a language with no grammar. Ignored when
   * `controlFlow` is set, since a parse tree is always the better answer.
   */
  regexControlFlow?: LanguageRegexControlFlowSpec;

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
  /** Call roots that indicate an HTTP/API client (call-graph classification). */
  apiCallRoots?: readonly string[];
  /** Call roots that indicate a database/ORM object (call-graph classification). */
  dbCallRoots?: readonly string[];

  /** AST/source-level extractor hooks. */
  ast?: AstExtractorHooks;
  /** Call extraction/classification hooks (see shared/call-graph.ts). */
  calls?: CallExtractionHooks;

  // ─── Domain extractors ───────────────────────────────────────────────────
  // The per-file extraction categories, carried on the meta so it is the ONLY
  // path from the registry to a plugin's heavy code (the domain index.ts files
  // dispatch via `pluginFor(language)`, they import no plugin modules).
  // Family plugins (javascript, java-kotlin) share ONE instance across their
  // member metas — instance identity is how project-level passes
  // (reconcileProjectEntities, resolveProjectDispatch) run each once.

  /** Route/endpoint extractor for tree-sitter languages (regex languages use `regexSpec.extractRoutes`). */
  routes?: RouteExtractor;
  /** Data-source extractor (API calls, DB/ORM reads, env vars, queue pub/sub). */
  dataSources?: DataSourceExtractor;
  /** Data-mutation extractor (setState/dispatch/assignment sites). */
  dataMutations?: DataMutationExtractor;
  /** ORM entity + relation extractor. */
  entities?: EntityExtractor;
  /** Function/class extractor for tree-sitter languages. */
  functionsClasses?: FunctionClassExtractor;
  /** Import/export extractor for tree-sitter languages. */
  importsExports?: ImportExportExtractor;
  /**
   * Project-level dispatch-indirection resolvers this plugin contributes
   * (MediatR, component emits, UI bridges). A resolver spanning several
   * languages rides on ONE owning meta; its `languages` field decides which
   * analyses it sees, and its `priority` fixes cross-plugin output order.
   */
  dispatchResolvers?: readonly DispatchResolver[];
  /**
   * How this language's declared types and properties serialize as JSON —
   * what the request-schema pass (`core/request-schemas.ts`) needs to turn a
   * route's body parameter into an OpenAPI-shaped schema. The pass owns the
   * recursion, class lookup and inheritance flattening; the plugin only says
   * what one type text means and what one property is called on the wire.
   */
  requestSchema?: RequestSchemaHooks;
}

/** What a declared type text denotes, for JSON serialization. */
export type TypeShape =
  | { kind: "scalar"; schema: import("./analysis.js").JsonSchemaNode }
  | { kind: "array"; element: string }
  | { kind: "map"; value: string }
  | { kind: "object"; name: string }
  /** `object`/`dynamic`/`JsonElement` — anything goes. */
  | { kind: "any" };

export interface RequestSchemaHooks {
  /**
   * Where a handler parameter binds from, for a framework whose handler
   * signature lives in another file than the route (Laravel `Ctl#action`,
   * Rails, VB, Rust, Dart) or carries no annotation at all. Called by the
   * project-level join for every parameter of a resolved handler; return null
   * for "nothing can be said" (the join then keeps the parameter with
   * `binding: null`), or a binding of `services` for framework-injected types
   * (`Request`, `Response`, `Context`) so a reader can skip them. The path
   * token rule (`{id}` → route) is applied by the join before this is asked.
   */
  bindParam?(param: import("./analysis.js").ParamInfo, route: import("./analysis.js").RouteInfo):
    import("./analysis.js").RouteParamBinding | null;
  /** Split the nullable marker off a type text (`int?` → `{ type: "int", nullable: true }`). */
  unwrapNullable(type: string): { type: string; nullable: boolean };
  /** Classify a (non-nullable) type text. */
  describeType(type: string): TypeShape;
  /** Property name as serialized (`[JsonPropertyName("x")]`, else the framework's default casing). */
  serializedName(prop: import("./analysis.js").PropertyInfo): string;
  /** Whether the property is part of the serialized shape at all (public instance, not ignored). */
  isSerialized(prop: import("./analysis.js").PropertyInfo): boolean;
  /** Whether a request must carry the property. */
  isRequired(prop: import("./analysis.js").PropertyInfo): boolean;
}
