import type { Node, Tree } from "web-tree-sitter";
import type {
  ClassInfo,
  EntryPointInfo,
  Language,
  SecurityCategory,
  SecuritySeverity,
  SecurityIssue,
  TypeReference,
  InteractiveElementInfo,
  SubComponentInfo,
  CustomElementDef,
  GlobalMemberDef,
  EventInfo,
  ImportInfo,
  FileAnalysis,
  PackageCategory,
  ExternalPackage,
  PackageEcosystem,
  PathArgCall,
  Instantiation,
  CallBaseRef,
  HttpClientRegistration,
  ProxyRule,
  GeneratedClientConfig,
  MigrationInfo,
} from "./analysis.js";
import type { ProjectInfo } from "./plugin.js";
import type { RouteExtractor } from "../extractors/routes/base.js";
import type { DataSourceExtractor } from "../extractors/data-sources/base.js";
import type { DataMutationExtractor } from "../extractors/data-mutations/base.js";
import type { EntityExtractor } from "../extractors/entities/base.js";
import type { FunctionClassExtractor } from "../extractors/functions-classes/base.js";
import type { ImportExportExtractor } from "../extractors/imports-exports/base.js";
import type { DispatchResolver } from "../extractors/dispatch/base.js";
import type { RouteResolver } from "../extractors/route-resolvers/base.js";

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

/** A dependency as a manifest declares it — core adds its `category`. */
export type DeclaredPackage = Omit<ExternalPackage, "category">;

/** Where one manifest file sits, for its parser. */
export interface ManifestFileContext {
  /** Path relative to the PROJECT root — what `ExternalPackage.declaredIn` records. */
  declaredIn: string;
  /** Path relative to the root being scanned (the analyzed root or a sub-project's). */
  path: string;
  /** Another file in the manifest's own directory (`Gemfile.lock` beside `Gemfile`); null when absent. */
  readSibling(name: string): Promise<string | null>;
  /**
   * A file at `relativePath` from the manifest's directory or the nearest one above it inside
   * the project (a module's build file reading the build's `gradle/libs.versions.toml`).
   */
  readAbove?(relativePath: string): Promise<string | null>;
}

/** One manifest format of a package manager, read at the analyzed root and at every sub-project root. */
export interface PackageManifestSpec {
  /**
   * File names at the root, read in order (`package.json`); with `glob`, glob
   * patterns under it for a format spread over many files (`**\/*.csproj`).
   */
  files: readonly string[];
  /** Read only the first of `files` that exists (`build.gradle.kts`, else `build.gradle`). */
  firstOnly?: boolean;
  /** `files` are globs read at most `deep`-1 directories below the root (see `core/glob.ts`), at most `limit` files. */
  glob?: { deep: number; limit: number };
  parse(text: string, file: ManifestFileContext): DeclaredPackage[] | Promise<DeclaredPackage[]>;
  /**
   * The package this manifest itself declares (Cargo `[package] name`, go.mod
   * `module`, package.json `name`), when the format has one: what a sibling
   * sub-project imports it by. Read at each sub-project root into
   * `SubProject.packageName`; the linker treats an import naming it as an
   * import of that sub-project.
   */
  selfName?(text: string): string | null;
  /**
   * Packages the manifest maps to a directory of this repository instead of a
   * download (go.mod `replace example.com/kit => ./kit`): `path` relative to
   * the manifest's directory. Recorded on `SubProject.packages` with that root.
   */
  localPackages?(text: string): Array<{ name: string; path: string }>;
}

/** A package of this repository by the name its importers write: its manifest's own name and the directory it is rooted at. */
export interface PackageRoot {
  name: string;
  /** Directory from the analysis root, posix, `""` for the root itself. */
  root: string;
}

/**
 * How a language's programs are configured to reach other services. Pure data
 * and pure functions: it lives on the static manifest, so it must not import
 * the plugin body.
 */
export interface ServiceConfigSpec {
  /** Configuration files read at each sub-project root. */
  sources?: readonly ConfigSourceSpec[];
  /**
   * Configuration files that declare forwarding rules (Angular `proxy.conf.json`,
   * YARP `ReverseProxy` in appsettings, `ocelot.json`), read at each root.
   */
  proxySources?: readonly ProxySourceSpec[];
  /**
   * A base expression as written (`process.env.ORDERS_URL`,
   * `_config["Services:Orders"]`, `os.environ["X"]`) → what it reads; null when
   * it reads nothing this language knows as configuration.
   */
  baseRefOf?(expr: string): CallBaseRef | null;
  /**
   * The environment variables that set configuration key `key` at runtime —
   * .NET `Services:Orders` ← `Services__Orders`, Spring `orders.url` ←
   * `ORDERS_URL`. Matched case-insensitively. Default: none (an env ref is
   * looked up by its own name only).
   */
  envNamesFor?(key: string): string[];
  /**
   * The base every route this language serves in a project is mounted under,
   * as the project's own configuration (read through `sources`, every entry —
   * not only addresses) states it: Spring `server.servlet.context-path`,
   * `spring.webflux.base-path`. Profile-specific values never decide it. Null
   * when nothing sets one, or the files disagree. Core prefixes the project's
   * complete API routes of this language with it.
   */
  routeBaseOf?(entries: ReadonlyArray<ConfigEntry & { file: string }>): RouteBase | null;
}

/** A configured base the routes of a project are served under (see `ServiceConfigSpec.routeBaseOf`). */
export interface RouteBase {
  /** `/league`: leading slash, no trailing one. */
  path: string;
  /** The key(s) that set it, as written (`server.servlet.context-path`). */
  key: string;
  /** Project-relative posix path of the file stating it. */
  file: string;
  line?: number;
}

/** One proxy-rule file format: where it sits under a project root, and how to read it. */
export interface ProxySourceSpec {
  files: readonly string[];
  glob?: { deep: number; limit: number };
  /** The forwarding rules the file declares; `file` is filled in by core. */
  parse(text: string, path: string): Array<Omit<ProxyRule, "file">>;
}

/** One configuration file format: where it sits under a project root, and how to read it. */
export interface ConfigSourceSpec {
  /** File names, or globs with `glob`, relative to the root (`appsettings.json`, `appsettings.*.json`). */
  files: readonly string[];
  glob?: { deep: number; limit: number };
  /** Every key → string value the file sets. Core keeps only URL-shaped values and drops the rest unread. */
  parse(text: string, path: string): ConfigEntry[];
}

/** A configuration value as a file states it. */
export interface ConfigEntry {
  key: string;
  value: string;
  line?: number;
  /** Environment profile the value applies to (`Development`, from `appsettings.Development.json`). */
  profile?: string;
  /** A test profile: it never decides where production calls go. */
  test?: boolean;
  /** An environment variable the profile sets (launchSettings `environmentVariables`), not a configuration key. */
  env?: boolean;
  /** A URL the project itself listens on (`applicationUrl`, Kestrel `Urls`), not one it calls. */
  listen?: boolean;
  /**
   * The name the project registers under in service discovery (Spring
   * `spring.application.name`): other services reach it by that name. Kept
   * though it is no URL.
   */
  serviceName?: boolean;
}

/**
 * A package manager a plugin owns: the manifests declaring its packages, and
 * how a source import names one of them. The inventory reads every
 * registered manifest whether or not a file of the plugin's language was
 * found (a `requirements.txt` beside no Python is still a declaration), which
 * is why this lives on the STATIC manifest. Two plugins may contribute
 * manifests to one ecosystem (Maven: Java's `pom.xml`, Scala's `build.sbt`);
 * only one of them says how imports match it.
 */
export interface PackageManagerSpec {
  ecosystem: PackageEcosystem;
  manifests: readonly PackageManifestSpec[];
  /**
   * Import source as written → the key packages are matched on (`@scope/pkg`
   * of `@scope/pkg/sub`); null when the import names no package (a relative
   * path, the stdlib). Unset: an import never names a package of this
   * ecosystem (Maven — a Java package is not an artifact), so usage stays
   * unknown.
   */
  importKey?(source: string): string | null;
  /** Declared package name → the key `importKey` produces for it (default: lowercased). */
  packageKey?(name: string): string;
  /**
   * An import key also reaches a package whose key it extends past
   * `separator` (`gorm.io/gorm/clause` → `gorm.io/gorm`) — and, `bidirectional`,
   * one that extends it (namespace `Microsoft.Extensions` ↔ package
   * `Microsoft.Extensions.Http`). Default: equal keys only.
   */
  prefixMatch?: { separator: string; bidirectional?: boolean };
  /**
   * Every import of a package is visible in source (npm, Go, Cargo, pub): a
   * declared package nothing imports is reported unused. Otherwise usage is
   * positive-only — a miss stays unknown.
   */
  assertsUnused?: boolean;
  /**
   * The import key whose use implies this package is used too (`@types/react`
   * → `react`, `@types/babel__core` → `@babel/core`); null when none.
   */
  impliedBy?(name: string): string | null;
  /**
   * Import keys resolved to their package through what the package manager
   * INSTALLED (Composer's `vendor/composer/installed.json` lists each
   * package's autoload namespaces): `load` reads a root's metadata into import
   * key → package name; an import reaches the package owning its longest key,
   * equal or extended past `separator`.
   */
  installedOwners?: {
    separator: string;
    load(readAtRoot: (relativePath: string) => Promise<string | null>): Promise<ReadonlyMap<string, string>>;
  };
  /**
   * The exported API of `name` as INSTALLED under one of `dirs` (each a
   * directory the package manager installs into, nearest first), read on
   * demand — never during analysis. With `symbol`, that export's declaration
   * too. Null when the package is not installed there.
   */
  installedApi?(dirs: readonly string[], name: string, symbol?: string): Promise<InstalledPackageApi | null>;
}

/** What an installed package exports, from its own declarations (`PackageManagerSpec.installedApi`). */
export interface InstalledPackageApi {
  name: string;
  version?: string;
  /** The file the API was read from, absolute. */
  source: string;
  exports: Array<{ name: string; kind: string; signature: string; file: string; line: number }>;
  /** More exports than were read (file or row cap reached). */
  truncated?: boolean;
  /** `symbol`'s declaration with its doc comment, when one was asked for and found. */
  declaration?: { text: string; file: string; line: number };
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
  /**
   * Match the whole text rather than line by line, for a statement formatted
   * across lines; reported at the line the match starts on. Keep such a
   * pattern anchored on something distinctive — it is run with the `g` flag.
   */
  multiline?: boolean;
  /**
   * Match the source as written, before the plugin's `securityPreprocess`
   * (which may blank strings and comments), and in comments too — for
   * credentials, which are leaked wherever they are written.
   */
  raw?: boolean;
  /** Only files whose project-relative path matches (Django's `DEBUG = True` means something only in settings). */
  files?: RegExp;
  /** The CWE a finding is an instance of, when the category's default is not it (`CWE-295` for TLS turned off). */
  cwe?: string;
  /**
   * A second look at a match the pattern alone cannot judge: handed the
   * scanned source (after `securityPreprocess`) and the offset the match
   * starts at, it may drop the finding or re-grade it with its own message —
   * an `innerHTML` template whose every interpolated value passes an escaper.
   * `undefined` keeps the finding as the rule states it. Not for `raw` rules.
   */
  judge?: (source: string, at: number) => SecurityJudgement | undefined;
}

/** How a language writes the comment that documents a declaration. */
export interface DocCommentSpec {
  /** Line-comment prefixes whose consecutive lines just above a declaration document it, most specific first (`///`, `//`). */
  line?: readonly string[];
  /** Block comments `[open, close]` ending just above a declaration (`/**` … `*\/`), most specific first. */
  block?: ReadonlyArray<readonly [string, string]>;
  /** The first statement of the body is a string literal that documents it (a Python docstring). */
  docstring?: boolean;
  /** Lines between the comment and the declaration that belong to the declaration: decorators, attributes, annotations. */
  attribute?: RegExp;
}

/** What a rule's `judge` decided about one match. */
export interface SecurityJudgement {
  /** Not a finding after all. */
  drop?: boolean;
  /** The severity it carries instead of the rule's. */
  severity?: SecuritySeverity;
  /** The message it carries instead of the rule's — saying why it was re-graded. */
  message?: string;
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
  /**
   * Node types that chain their operands with a `logicalOps` token child
   * rather than an `operator` field — the shell's `list` (`build && deploy
   * || rollback`, an unnamed token), F#'s `infix_expression` (a named
   * `infix_op` leaf). Each such token is a branch.
   */
  logicalOpNodes?: ReadonlySet<string>;
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
   * table names. `negated` marks a construct whose body runs when the capture is
   * false (`unless x`, `until x`); its condition is drawn as `!x`, so the graph's
   * true/false edges read right.
   */
  statements: readonly { match: RegExp; type: string; negated?: boolean }[];
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
  /**
   * Keyword-delimited blocks (`if … end`, `do … end`, `End If`, `Next`): what one
   * blanked, trimmed line opens. When set it replaces brace counting; what a line
   * closes is still `blockClose` (every match, and the run the line starts with).
   * `open` names each block the line opens, innermost last; `middle` marks a line
   * that continues the enclosing block at the block's own level (`else`, `elsif`,
   * `rescue`, `Catch`). The scan keeps a stack of these names, which is how a
   * modifier `if` (`return x if y`) is told from one that opens a block: only the
   * hook knows, and it says.
   */
  blockDelta?: BlockDelta;
  /** Block names whose `middle` lines are arms of the block, not a step out of it (`else` in a Ruby `case`). */
  armBlocks?: ReadonlySet<string>;
  /**
   * A guarded statement on one line that is not `if (cond) stmt`: Ruby's `stmt if
   * cond`, VB's `If c Then s`. Returns the condition and the guarded statement, and
   * `negated` when the statement runs on a false condition (`stmt unless cond`).
   */
  inlineGuard?: InlineGuard;
}

/** See `LanguageRegexControlFlowSpec.blockDelta`. */
export type BlockDelta = (code: string) => { open: readonly string[]; middle?: boolean };
/** See `LanguageRegexControlFlowSpec.inlineGuard`. */
export type InlineGuard = (code: string) => { head: string; tail: string; negated?: boolean } | null;

/**
 * Optional AST/source-level extractor hooks for tree-sitter languages.
 * A language without a hook simply contributes nothing for that field —
 * exactly like the old shared extractors that returned [] for languages
 * they didn't understand.
 */
export interface AstExtractorHooks {
  /**
   * Request input followed to a dangerous call inside each request handler
   * (shared/handler-taint.ts). Merged with the regex findings; a finding of
   * the same category on the same line replaces the regex one.
   */
  taint?(tree: Tree, sourceText: string, filePath: string, facts?: import("./analysis.js").TaintFacts): import("./analysis.js").SecurityIssue[];
  /** Type-position references from the raw AST (params, casts, new-expressions). */
  typeReferences?(tree: Tree, filePath: string): TypeReference[];
  /** Interactive UI elements (buttons, inputs with handlers) from the AST. */
  interactiveElements?(tree: Tree, sourceText: string): InteractiveElementInfo[];
  /**
   * The calls a file's markup makes outside any script function — a Vue/Svelte
   * template's `@click="markAllRead"`, `@save="store.actions.updateOne($event)"`.
   * Core classifies them like the file's own calls and adds them to `<setup>`,
   * the component's scope the template closes over. Null/empty when the file's
   * handlers already sit inside functions (JSX).
   */
  markupCalls?(elements: readonly InteractiveElementInfo[], filePath: string): import("./analysis.js").CallInfo[];
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
  /** Members installed on every component instance → `FileAnalysis.globalMembers`. */
  globalMembers?(sourceText: string): GlobalMemberDef[];
  /** HTTP client instances created with a base URL → `FileAnalysis.httpClientBases`. */
  httpClientBases?(tree: Tree, sourceText: string): Record<string, string>;
  /** State-store module registrations → `FileAnalysis.storeModules`. */
  storeModules?(tree: Tree, sourceText: string): Array<{ name: string; ref: string; line: number }>;
  /** HTTP clients configured with a base, host included → `FileAnalysis.httpClientRegistrations`. */
  httpClientRegistrations?(tree: Tree, sourceText: string): HttpClientRegistration[];
  /** Infrastructure the code declares (AWS CDK constructs) → `FileAnalysis.deployedResources`. */
  deployedResources?(tree: Tree, sourceText: string): import("./analysis.js").DeployedResourceFact[];
  /** Entry points that are not routes — MCP tools, editor commands, CLI commands → `FileAnalysis.entryPoints`. */
  entryPoints?(tree: Tree, sourceText: string): EntryPointInfo[];
  /** Forwarding rules a code file declares (`vite.config.ts` `server.proxy`) → `FileAnalysis.proxyRules`. */
  proxyRules?(tree: Tree, sourceText: string, filePath: string): ProxyRule[];
  /** API-client generators a config file sets up (`kubb.config.ts`) → `FileAnalysis.generatedClients`. */
  generatedClients?(tree: Tree, sourceText: string, filePath: string): GeneratedClientConfig[];
  /** Calls handing a path literal to a project function → `FileAnalysis.pathArgCalls`. */
  pathArgCalls?(tree: Tree, sourceText: string): PathArgCall[];
  /** Listeners bound to page elements by selector → `FileAnalysis.domBindings`. */
  domBindings?(tree: Tree, sourceText: string): import("./analysis.js").DomBinding[];
  /** Project classes constructed with a string argument → `FileAnalysis.instantiations`. */
  instantiations?(tree: Tree, sourceText: string): Instantiation[];
  /** URL-shaped module-level values by name (`environment.apiUrl`) → `FileAnalysis.moduleValues`. */
  moduleValues?(tree: Tree, sourceText: string): Record<string, string>;
  /** URL-holding markup attributes the file's scripts read → `FileAnalysis.attributeReads`. */
  attributeReads?(tree: Tree, sourceText: string): Array<{ attribute: string; method?: string; line: number }>;
  /**
   * Paths the file names as string data that the toolchain loads as modules
   * (glob imports, worker URLs, config-file script paths) →
   * `FileAnalysis.pathReferences`, which reachability follows.
   */
  pathReferences?(sourceText: string): string[];
  /**
   * Variable → import-source aliases, any scope
   * (`const store = useUserStore()` → store resolves to useUserStore's source).
   * A rich binding also names the FACTORY the variable came from, so a member
   * call whose leaf doesn't exist in the source module (`mutation.mutateAsync`)
   * can fall back to the factory symbol (see CallInfo.via).
   */
  variableAliases?(tree: Tree, imports: ImportInfo[]): Map<string, string | VariableAliasBinding>;
  /**
   * Dependency-injection container registrations in the file
   * (`services.AddScoped<IRepo, Repo>()`, `{ provide: X, useClass: Y }`, a
   * Spring stereotype class) → `FileAnalysis.diBindings`. The symbol linker
   * joins them to injection points project-wide; the hook only reports what
   * this file registers.
   */
  diBindings?(tree: Tree, sourceText: string, filePath: string): import("./analysis.js").DiBinding[];
  /** Type aliases the file declares → `FileAnalysis.typeAliases` (the aliased type as written; core follows them). */
  typeAliases?(tree: Tree, sourceText: string): import("./analysis.js").TypeAliasInfo[];
  /** The namespace the file's free functions live in → `FileAnalysis.declaredNamespace` (PHP `namespace X;`). */
  declaredNamespace?(tree: Tree, sourceText: string): string | null;
  /**
   * Typed locals of the file's TOP-LEVEL statements (C# `Program.cs`,
   * a script body) → the `<setup>` pseudo-function's `localTypes`, so
   * `var pricing = app.Services.GetRequiredService<IPricing>(); pricing.Quote()`
   * resolves like it would inside a method.
   */
  topLevelLocalTypes?(tree: Tree, sourceText: string): import("./analysis.js").FunctionInfo["localTypes"];
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
  /**
   * The source is one block of a larger file (a Vue / Svelte `<script>`): the
   * rest — a template — may use what the block imports, so no import of it is
   * judged unused.
   */
  embedded?: true;
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
   * A class BODY may be listed too (Java's `new Task<T>() { public T get() {
   * … } }`, met inside a method body): the methods it declares belong to no
   * named symbol, so a nested scope whose parent is an anonymous scope is read
   * on as well.
   */
  anonymousScopeTypes?: readonly string[];
  /**
   * A node that DEFINES a named function, for a grammar whose function and
   * value bindings share one node type (F# `let f x = …` vs `let x = …`, both
   * `function_or_value_defn`): the module-level walk that builds `<setup>`
   * stops at it, while a function body's walk still reads the body's local
   * value bindings (which a `nestedScopeTypes` entry would cut off).
   */
  isFunctionDefinition?(node: Node): boolean;
  /**
   * A nested function the module-level walk that builds `<setup>` reads into:
   * an anonymous callback that runs on the module's behalf (`computed(() => …)`,
   * `useQuery({ queryFn: async () => … })`), unlike a function bound to a name
   * or a handler registered on a router. Absent: the walk stops at every one.
   */
  runsAtTopLevel?(node: Node): boolean;
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
  /**
   * The type a call's receiver EXPRESSION evaluates to, when the expression
   * says so itself — a service-locator lookup chained straight into the call
   * (`app(Mailer::class)->send()`, `sp.GetRequiredService<IMailer>().Send()`).
   * Called for every call node, so it must bail out cheaply on the receiver's
   * node type. Sets `CallInfo.receiverType` / `receiverQualifier`.
   */
  receiverTypeOf?(node: Node): { type: string; qualifier?: string } | null;
  /**
   * The name a dispatching call routes on (`dispatch('contacts/get')` →
   * "contacts/get"), or null. Called for every call node: bail out cheaply.
   * Sets `CallInfo.key`.
   */
  keyOf?(node: Node): string | null;
  /**
   * The argument expressions a call passes, as written, or null. Called for every
   * call node: bail out cheaply, and report only the calls a project pass needs
   * (the output keeps them). Sets `CallInfo.args`.
   */
  argsOf?(node: Node): string[] | null;
  /**
   * How many arguments the call passes (a trailing lambda counts): in a
   * language with overloading the linker picks the overload whose arity
   * accepts it, and the patch check compares it with the definitions. Null
   * when it cannot be told (a spread argument). Sets `CallInfo.argCount`.
   */
  argCountOf?(node: Node): number | null;
  /**
   * Where the call's arguments come from, when the plugin can tell for at
   * least one: a literal, the enclosing function's parameter, a route or
   * query parameter of the current URL. Sets `CallInfo.argOrigins`; read by
   * the `paramOrigins` project pass.
   */
  argOriginsOf?(node: Node): import("./analysis.js").CallArgOrigin[] | null;
  /**
   * The language has no overloading — a second definition of a name is an
   * overload signature, a typing stub or a conditional redefinition, not a
   * body to choose (TypeScript, Python, PHP): calls are not split by their
   * argument count, and the linker never picks a definition by it.
   */
  noOverloads?: boolean;
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
/** Tests to run: a test file, and the test functions in it a change reaches (empty = the whole file). */
export interface TestTarget {
  file: string;
  /** As the symbol linker spells them: `test_total`, `OrdersTest.createsOrder`, `TestParse`. */
  names: string[];
}

/** What a test command is built from besides the tests: the project's packages and the manifests declaring them. */
export interface TestCommandContext {
  /** Every declared package name (`vitest`, `pytest`, `rspec`). */
  packages: ReadonlySet<string>;
  /** Basenames of the manifests packages are declared in (`pom.xml`, `build.gradle.kts`, `package.json`). */
  manifests: ReadonlySet<string>;
}

/** What a plugin's import resolver may ask of the project (`LanguagePluginManifest.resolveImport`). */
export interface ImportResolveContext {
  /** Every analyzed file, posix paths from the project root. */
  files: ReadonlySet<string>;
  /** The file declares a function, class or type of that name. */
  declares(file: string, name: string): boolean;
  /** The sources of the file's own wildcard imports (`pub use chat_sql::*`, `from x import *`). */
  globImportsOf(file: string): readonly string[];
}

export interface LanguagePluginManifest {
  language: Language;
  /**
   * The project file an import names, for a language whose imports name
   * modules by a path of its own (`crate::util`, `other_crate::persistence`):
   * the import index asks this before its generic path rules. `specifier` is
   * the name bound when the caller has one; null when the module is not the
   * project's. Leaf code: it reads only `ctx`.
   */
  resolveImport?(importingFile: string, source: string, specifier: string | undefined, ctx: ImportResolveContext): string | null;
  /**
   * The directory a package import names, for a language whose import path is
   * the package's own name plus its directory (`importsNameDirectories` — a Go
   * import is the go.mod module path, then the directory under that module):
   * the directory from the analysis root; null when the import is no package
   * of this repository (the standard library, a download); undefined when the
   * packages cannot say (no manifest declares a name), and core falls back to
   * matching the import's trailing segments against directory names.
   * `packages` are this repository's packages of the language's ecosystems;
   * `hasDirectory` says whether an analyzed file lies directly in a directory.
   * Leaf code.
   */
  packageDirectory?(importingFile: string, source: string, packages: readonly PackageRoot[], hasDirectory: (dir: string) => boolean): string | null | undefined;
  /**
   * The project file an import names by the language's own rules, the path
   * from the analysis root: through a package of this repository by the name
   * its manifest declares (Dart `package:league/models/club.dart` → the
   * `league` package's `lib/models/club.dart`), or relative to the importing
   * file (`'club.dart'`). Null when the import names no file of the repository
   * (the SDK, a download), undefined when the rules cannot say and the generic
   * path rules decide. Asked by the symbol linker. Leaf code.
   */
  importedFile?(importingFile: string, source: string, packages: readonly PackageRoot[]): string | null | undefined;
  /**
   * The command that runs these tests with the language's usual runner — by
   * test function where the runner can filter by name, else by file. Null
   * when it cannot say. Used by the impact report ("tests to run").
   */
  testCommand?(tests: readonly TestTarget[], ctx: TestCommandContext): string | null;
  /**
   * Calls that block the thread they run on — matched against a call's
   * `receiver.name` and its bare name. An async function calling one stalls
   * every caller (`readFileSync`, `time.sleep`, `requests.get`).
   */
  blockingCalls?: RegExp;
  /** How files of this language are parsed. */
  parsing: "tree-sitter" | "regex" | "custom";
  /**
   * File extensions (with leading dot) owned by this language. An extension
   * has ONE owner — the registry throws on a second claim. A plugin whose
   * extension also names foreign formats (openapi's `.json`, a `.d` make
   * dependency file) refuses those files in `preprocess` with `{ skip }`.
   */
  extensions: readonly string[];
  /**
   * Language family: languages whose files resolve each other's bare-name
   * imports (`jvm` = Java/Kotlin/Scala, `dotnet` = C#/VB/XAML/Razor, `cfam` =
   * C/C++/Objective-C, `script` = JS/TS/Vue/Svelte). Bare-name resolution only
   * trusts candidates in the importer's own family — Pascal `uses X` never
   * imports a .js file. Unset: no family, so candidates are not filtered.
   */
  family?: string;
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
   * One type's declaration can be split across files of a directory — C#/VB
   * partial classes, Swift/Dart extensions, Obj-C categories, C++
   * out-of-line member definitions, Rust `impl` blocks, Go methods beside
   * their struct, reopened Ruby classes. The linker then treats same-named
   * classes of one directory as ONE type (shared members, methods found in
   * sibling files, counted once). Elsewhere (Python, JS/TS, Java, PHP, …)
   * two such classes are different types and stay apart.
   */
  typesSpanFiles?: boolean;
  /**
   * A render call's template name as the paths its template file may end with,
   * for a framework that spells names its own way: Laravel `view('clubs.show')`
   * → `views/clubs/show.blade.php`, CodeIgniter `view('clubs/edit')` →
   * `views/clubs/edit.php`. The file they name is a template even in this
   * language. None leaves the name to the generic path-suffix match.
   */
  templatePaths?(name: string): string[];
  /**
   * Identifiers are case-insensitive (VB, Pascal/Delphi): `_repo.save()`
   * calls the `Save` that `_Repo`'s class declares. The linker then matches
   * member, local, parameter and method names without regard to case.
   */
  caseInsensitiveNames?: boolean;
  /**
   * Function and method names are case-insensitive while variables and
   * properties are not (PHP): `$this->writeUTF()` calls the `writeUtf` the
   * class declares, but `$Repo` is not `$repo`. The linker folds case only
   * when it looks a callable up, after an exact match fails.
   */
  caseInsensitiveCallables?: boolean;
  /**
   * A design file (Delphi `.dfm`/`.lfm`/`.fmx`): its root object names the
   * class its code unit declares (`object frmPlayers: TfrmPlayers`) and
   * describes that form's components. The linker never takes such a class as
   * a type definition of its own — the code declaration is the type, and a
   * second "definition" would make every `form: TfrmPlayers` ambiguous.
   */
  designFormat?: boolean;
  /**
   * Class-level calls that construct an instance (Delphi `TFoo.Create(…)`,
   * Ruby/Crystal `Foo.new`): a `X.<name>` call on a class that declares no
   * method of that name reaches the class's constructor.
   */
  constructorCalls?: readonly string[];
  /**
   * Generic types an `await` unwraps to their first type argument — what a
   * local initialized by `await repo.FindAsync(id)` holds when `FindAsync`
   * declares `Task<User>` (C# `Task`/`ValueTask`, TS `Promise`, Dart
   * `Future`). Unset where an async function declares the awaited type
   * itself (Python, Kotlin `suspend`). Rust lists its `Result`/`Option` here:
   * `?` and `.unwrap()` unwrap them the way an `await` unwraps a task. An
   * entry `*Result` matches by suffix (a project's `type FlowyResult<T>`).
   */
  asyncResultTypes?: readonly string[];
  /**
   * An import puts the imported file's top-level functions in scope without
   * naming them — PowerShell dot-sourcing / `Import-Module`, Bash `source`:
   * a bare call no definition in its own file answers is linked to the ONE
   * imported file that defines it. Unset for module systems that bind names
   * explicitly (JS, Python, Java), where such a call names something else.
   */
  importsShareScope?: boolean;
  /**
   * A class lists several bases that are all classes (Python `class D(B, C)`):
   * its `extends` and `implements` together, in order, are its bases, and a
   * member is looked up along the C3 method resolution order.
   */
  multipleInheritance?: boolean;
  /**
   * How a call's argument count is judged against a definition of this
   * language (the patch check). Unset: every parameter without a default is
   * required and no more arguments than parameters are accepted.
   */
  callArity?: {
    /** Fewer arguments than parameters are accepted (JavaScript: the rest are `undefined`). */
    missingAllowed?: boolean;
    /** More arguments than parameters are accepted (PHP userland functions, JavaScript). */
    extraAllowed?: boolean;
    /**
     * Decorators known to keep the signature as written; a definition with any
     * other is not judged — a decorator may inject or rewrite parameters
     * (Python `@inject`, `@click.option`). Unset: decorators are never judged
     * to change the signature.
     */
    signatureKeepingDecorators?: readonly string[];
  };
  /**
   * Every file of a directory shares one top-level scope (Go: a package IS
   * its directory; Kotlin and Swift files of one package/module): a bare call
   * the caller's file does not define reaches the ONE other non-test file of
   * that directory declaring the function. Two declarations (build-tagged
   * `x_linux.go` / `x_windows.go`) decide nothing.
   */
  directoryScope?: boolean;
  /**
   * Fields are only reached through the instance — `this.x`, `self.x`,
   * `$this->x` — and the call extractor keeps that head (JS/TS, Python,
   * PHP): a bare `repo.find()` names a local, parameter or global, never a
   * field. Languages with implicit `this` (Java, C#, Kotlin, Swift, …) and
   * regex extractors that drop the head (`self.repo.find(` → `repo.find`)
   * leave it unset, so a bare name may still be a field.
   */
  explicitSelfMembers?: boolean;
  /**
   * A module's top-level names reach another file only through an import
   * naming them (JS/TS, Python): in a module, a class name the file neither
   * declares nor imports is a global (`Map`, `Response`), never another
   * module's class of that name. A file with no import and no export is a
   * script, whose declarations are global, and is exempt on either side, as
   * is any file a wildcard or namespace import could reach. `autoImport`
   * names the files whose presence in a sub-project makes its exports global
   * without any import (a Nuxt config, unplugin-auto-import's declarations):
   * there the rule is off.
   */
  importsBindNames?: { autoImport?: RegExp };
  /**
   * Every function in a file sees its module-scope bindings (`const api =
   * useUserApi()` at the top of a JS module or a Vue `<script setup>`): a name
   * a function's own scope does not bind is looked up among the `<setup>`
   * locals. Unset where a function cannot see them (a Ruby `def`).
   */
  moduleLocalsInScope?: boolean;
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
   * Package managers this plugin owns — manifest parsers and import matching
   * (see `PackageManagerSpec`). Family plugins attach them to ONE member.
   */
  packageManagers?: readonly PackageManagerSpec[];
  /**
   * How a project of this language is built, tested and started, read off the files at its root
   * (package.json scripts, go.mod, Cargo.toml, pom.xml, a `.csproj`, …) — what an agent orients by
   * (`ProjectAnalysis.projectCommands`, `clarifydoc_status`). Static manifest data, like `packageManagers`.
   */
  projectCommands?: ProjectCommandSpec["commands"];
  /**
   * Ecosystems this language's imports are matched against — usually one;
   * Swift/Objective-C import from SwiftPM AND CocoaPods packages.
   */
  packageEcosystems?: readonly PackageEcosystem[];
  /**
   * How this language's programs are told where other services are: the
   * configuration files they read, the expressions that read them, and how an
   * environment variable addresses a configuration key. Core's call-origin
   * pass reads only this; it names no language, file or framework.
   */
  serviceConfig?: ServiceConfigSpec;
  /**
   * Extension-less SOURCE files this language owns, by basename — Play's
   * `conf/routes`. Discovery globs by extension, so without this such a file
   * is never analysed; the registry maps the basename to the language and
   * `getLanguageForFile` checks it before the extension.
   */
  namedFiles?: readonly string[];
  /**
   * Directories discovery skips as build output that this ecosystem keeps
   * SOURCE in, and the marker that says so — `bin/` is .NET's build output
   * everywhere else: `{ dir: "bin", marker: "bin/dune" }` (dune keeps
   * executables there), `{ dir: "bin", marker: "META6.json" }` (a Raku
   * distribution's scripts). The marker path is relative to the directory's
   * parent; the directory is read with the default ignores below it.
   * `markerMatches` narrows it to markers whose text matches (`package.json`
   * declaring `"bin"`).
   */
  sourceDirs?: ReadonlyArray<{ dir: string; marker: string; markerMatches?: RegExp }>;
  /**
   * Files a default ignore skips that are this ecosystem's SOURCE where a
   * marker says so: below each `marker` file whose text `markerIs` accepts,
   * the files matching `pattern` — which must be the very default ignore the
   * rule lifts — are read too. TypeScript's hand-written types package:
   * `{ marker: "package.json", pattern: "**\/*.d.ts", markerIs: <a types-only manifest> }`.
   */
  readmitFiles?: ReadonlyArray<{ marker: string; pattern: string; markerIs(text: string): boolean }>;
  /**
   * A file named with this prefix is also importable without it — Sass's
   * partials: `@use "buttons"` loads `_buttons.scss` (and `@use "theme"`
   * a `theme/_index.scss`). Import resolution tries the prefixed name.
   */
  partialPrefix?: string;
  /**
   * An import the file writes relative to itself is also searched on load
   * paths the build configures (Sass `includePaths` / `loadPaths`): when it
   * names nothing beside the importer, the one file of the family whose path
   * ends that way is meant. Off, a relative import names exactly one place.
   */
  importLoadPaths?: boolean;
  /**
   * Infixes a bundler picks between per target platform: React Native loads
   * `Button.ios.tsx` or `Button.android.tsx` for `./Button`. A file so named
   * also answers to the plain name when no plain file exists (the first
   * suffix listed wins), and dead-code resolution keeps every variant alive.
   */
  platformSuffixes?: readonly string[];
  /**
   * OTHER languages this plugin's `dispatchResolvers` act on (beyond its own).
   * Discovering any of them lazy-loads this plugin too, so a cross-language
   * resolver still runs when its owner's language is absent — e.g. csharp's
   * UI-bridge resolver joins VB/XAML code-behind in a pure-VB MAUI project.
   */
  dispatchLanguages?: readonly Language[];
  /**
   * The language DESCRIBES an API rather than implementing it — OpenAPI,
   * GraphQL SDL, WSDL, JSight. Its routes state a served surface and carry no
   * handler code: the cross-tier linker prefers the implementing route when
   * both exist, and symbol links never treat its "functions" as code.
   */
  apiContract?: boolean;
  /**
   * A non-relative import names a PACKAGE DIRECTORY, every file of which it
   * loads — Go `import "app/handler"`, Rust `mod` trees, Ruby load paths. The
   * component graph resolves such an import to the one project directory
   * whose path ends with the longest run of the import's segments (two
   * directories tied → no edge), and within it to the files declaring a name
   * the importer uses.
   */
  importsNameDirectories?: boolean;
  /**
   * Migration files of this ecosystem's tools, recognised by path convention
   * (`db/migrate/<version>_<name>.rb`, Flyway's `V2__x.sql`): each rule names
   * the ecosystem and the migration, or returns null. Read for every
   * discovered file whatever language owns it (a Prisma `migration.sql` is
   * the SQL plugin's file), so rules of different plugins must not overlap.
   */
  migrationFiles?: readonly MigrationFileRule[];
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
  /**
   * Generic wrappers a member call passes straight through to their first
   * type argument — Rust `Arc`/`Box`/`Rc` (auto-deref), Python `Annotated`.
   * Lets an injected `repo: Arc<dyn UserRepo>` resolve `self.repo.find()`
   * against `UserRepo` (see `receiverTypeName` in shared/type-parser.ts).
   * A wrapper whose calls need an explicit hop (`Optional<T>.get()`,
   * `Lazy<T>.Value`) must NOT be listed.
   */
  transparentTypeWrappers?: readonly string[];

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

  /**
   * How the language documents a function or class, so its first sentence
   * becomes `FunctionInfo.doc` / `ClassInfo.doc` (core/doc-comments.ts).
   * Shared shapes live in `extractors/shared/doc-comment-specs.ts`.
   */
  docComments?: DocCommentSpec;

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
  /**
   * A DB root that is also a common variable name counts only when the
   * receiver's declared type, where the code states one, is a database type:
   * `{ session: /^(?:Session|StatelessSession)$/ }` keeps Hibernate's
   * `session.save(x)` and drops a `FooSession session` whose `session.users()`
   * is no query. Keys are lower-case roots; the type is matched without its
   * package and type arguments.
   */
  dbRootTypes?: Readonly<Record<string, RegExp>>;

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
   * Names a framework puts in scope without an import line (Nuxt's
   * `composables/` and `utils/` exports): a project pass, run once before the
   * import index and the linker, that adds to each file the `ImportInfo` it
   * would have written for every such name it calls, so the call resolves as
   * an imported one. In memory only, never into the per-file JSON. Returns how
   * many imports it added. Shared by a family's metas (run once by identity).
   */
  autoImports?: (analyses: FileAnalysis[]) => number;
  /**
   * Project-level route passes this plugin contributes (inherited controller
   * route templates, urlconf includes, router registrations). Each sees the
   * analyses of its `languages` plus the `ProjectContext`, and rewrites
   * `routes` before mounts compose and before the symbol linker anchors them.
   */
  routeResolvers?: readonly RouteResolver[];
  /**
   * How this language's declared types and properties serialize as JSON —
   * what the request-schema pass (`core/request-schemas.ts`) needs to turn a
   * route's body parameter into an OpenAPI-shaped schema. The pass owns the
   * recursion, class lookup and inheritance flattening; the plugin only says
   * what one type text means and what one property is called on the wire.
   */
  requestSchema?: RequestSchemaHooks;
  /**
   * The gRPC service a stub type or stub-building call names, by protoc's
   * naming for this language (`pb.OrderServiceClient` /
   * `pb.NewOrderServiceClient()` → `OrderService`, `GreeterStub`,
   * `OrderServiceGrpc.newBlockingStub()`, `Greeter.GreeterClient`). `spelling`
   * is a declared type or a local's initializer as `callChainText` writes it.
   * `certain` when the spelling is protoc's own; an uncertain one (a
   * dynamically loaded client class) counts only when a `.proto` in the
   * project declares the service. Core's gRPC client pass
   * (`core/grpc-clients.ts`) reads only this.
   */
  grpcStubService?: (spelling: string, file: FileAnalysis) => { service: string; certain: boolean } | null;
  /**
   * The gRPC service a class implements, read off protoc's generated base for
   * it (`CartService.CartServiceBase`, `…Grpc.…ImplBase`, `…Servicer`, an
   * embedded `Unimplemented…Server`, `…::Service`), or null: the class whose
   * methods serve that `.proto` service's rpcs.
   */
  grpcServiceOf?: (cls: ClassInfo) => string | null;
  /**
   * How this language's toolchain finds files — what dead-code analysis
   * (`core/dead-code.ts`) needs to tell a file nothing loads from one that is
   * loaded by convention. Declaring it opts the language's files into being
   * JUDGED. A language whose files are found by namespace, package or
   * autoload convention (C#, Java, PHP, Rails) must leave it unset: an import
   * graph cannot prove those unreachable. Family plugins share ONE instance,
   * so core loads it once.
   */
  reachability?: ReachabilityHooks;
}

export interface ReachabilityHooks {
  /**
   * Once per analysis: read what the ecosystem's toolchain config says about
   * entry points (package.json `main`/`bin`/`exports`/`scripts`, …) and
   * return the model core resolves every file of the language through.
   */
  load(ctx: ReachabilityLoadContext): Promise<ReachabilityModel>;
}

export interface ReachabilityLoadContext {
  /** Absolute path of the analyzed root. */
  projectRoot: string;
  /** Project roots, posix and project-relative; "" is the analyzed root. */
  roots: readonly string[];
  /** Every analyzed file (posix, project-relative). */
  files: ReadonlySet<string>;
}

export interface ReachabilityModel {
  /**
   * Files the toolchain starts from, read from manifests (package.json
   * `main`, `bin`, `exports`, files named in `scripts`), with the reason.
   * Their exports are public API — never reported unused.
   */
  manifestEntries: ReadonlyArray<{ file: string; reason: string }>;
  /**
   * Why a file is loaded by a framework or tool by convention rather than by
   * import (a Next.js page, a `*.config.ts`, a Storybook story), or null.
   * `relPath` is relative to the file's own project root; `frameworks` are
   * the framework ids detected for the analysis.
   */
  entryReason(
    analysis: FileAnalysis,
    relPath: string,
    frameworks: ReadonlySet<string>,
    /** The file's source text, read on demand (an `@main` attribute, a `__FILE__ == $0` guard). */
    readSource?: () => string | undefined,
  ): string | null;
  /**
   * Names a file declares that OTHER files use without naming the file — a
   * C# or Java type referenced across its namespace/package, a PHP class
   * autoloaded on first use, a C function called through a header, a Ruby
   * constant Zeitwerk loads. When set, any reachable file whose text contains
   * one of these names (as a whole identifier, comments and strings
   * included) reaches this file. Over-matching only keeps code alive.
   */
  declaredNames?(analysis: FileAnalysis, source: string | undefined): readonly string[];
  /**
   * Identifiers the toolchain reads from configuration the model scanned at
   * load — AndroidManifest components, `web.xml` servlets, an `.app.src`
   * application module, types named in `appsettings.json`. A file declaring
   * one is an entry point: the framework instantiates it by that name.
   */
  configMentions?: ReadonlySet<string>;
  /**
   * Files compiled as ONE unit (a Go package is its directory): reaching any
   * file of a unit reaches all of them. null = the file is its own unit.
   */
  unitOf?(filePath: string): string | null;
  /**
   * Why a file is run by a TOOL rather than being part of the program — a
   * migration, a script under `scripts/`, a tool config, a Storybook story.
   * Such a file keeps what it loads alive and is never reported, but it is
   * no evidence of where the program starts, so it anchors nothing (a
   * project whose only "entry" is a migration is not judged). Same arguments
   * as `entryReason`, which is asked first.
   */
  passiveReason?(
    analysis: FileAnalysis,
    relPath: string,
    frameworks: ReadonlySet<string>,
    readSource?: () => string | undefined,
  ): string | null;
  /** Files consumed without being imported (ambient `.d.ts`): never judged. */
  isAmbient?(filePath: string): boolean;
  /**
   * Resolve a module specifier as written in `fromFile` to the project files
   * it loads. `[]` = an external package (precisely nothing local); null = it
   * looks local but cannot be pinned down (an alias the model doesn't know).
   * Several files = all of them load (a Python import runs every package
   * `__init__` on the way) or the target is ambiguous; core treats all as
   * reached. `specifiers` are the import's bound names, for languages where
   * a name can be a module (`from pkg import mod`).
   */
  resolve(fromFile: string, source: string, specifiers?: readonly string[]): string[] | null;
  /**
   * Whether this language's imports name what they use precisely enough to
   * report unused exports. False where a module is used through a qualified
   * path (`processor::run()`) or an import keeps only its alias — the files
   * are still judged. Default true.
   */
  judgeExports?: boolean;
  /** Resolve a `FileAnalysis.pathReferences` entry (globs allowed) to project files. */
  resolvePath(fromFile: string, ref: string): string[];
  /**
   * Files a template tag used WITHOUT an import may render (auto-imported or
   * globally registered components). Optional; core counts every candidate
   * as reached.
   */
  resolveTag?(fromFile: string, tag: string): string[];
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
  /**
   * Whether a class's `implements` are parents whose properties it carries, as
   * its `extends` is (OpenAPI `allOf` over several refs) — flattened after it.
   */
  composesImplements?: boolean;
}

/** What a `projectCommands` reader sees of one project root. */
export interface ProjectRootView {
  /** Names directly in the root (files and directories). */
  entries: readonly string[];
  /** A file under the root, by relative path; undefined when absent or unreadable. */
  read(rel: string): string | undefined;
  /** Whether a path exists under the root. */
  exists(rel: string): boolean;
}

export interface ProjectCommandSpec {
  /** The commands the root's files state or imply; empty when the language's files are not there. */
  commands(root: ProjectRootView): ProjectCommand[];
}

export interface ProjectCommand {
  kind: "build" | "test" | "start" | "dev" | "lint";
  /** As a person types it at the project root: `npm test`, `go test ./...`, `./gradlew build`. */
  command: string;
  /** Where it was read: `package.json scripts.test`, `go.mod`. */
  source: string;
}

/** A migration file recognised by its path: its ecosystem and the migration's name, or null. */
export type MigrationFileRule = (path: string) => { ecosystem: MigrationInfo["ecosystem"]; name: string } | null;
