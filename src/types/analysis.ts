/** Supported languages for analysis */
export type Language =
  | "typescript" | "javascript" | "csharp" | "python" | "java" | "kotlin" | "pascal" | "dfm"
  | "go" | "rust" | "ruby" | "php" | "swift" | "lua" | "scala"
  | "perl" | "vb" | "sql" | "c" | "cpp" | "prisma" | "dart" | "elixir" | "erlang" | "objc"
  | "haskell" | "clojure" | "blazor" | "html" | "erb" | "heex" | "handlebars" | "liquid" | "velocity" | "razor" | "gotemplate" | "freemarker" | "qml" | "qtui" | "xaml" | "jsp" | "springxml" | "jsight"
  | "openapi" | "graphql" | "wsdl" | "groovy" | "powershell" | "bash" | "batch" | "fsharp" | "coffeescript" | "r" | "julia" | "crystal" | "zig" | "ocaml" | "raku" | "racket" | "scheme" | "commonlisp"
  | "nim" | "dlang" | "vlang" | "fortran" | "haxe" | "mojo" | "serverless" | "coredata" | "storyboard" | "terraform" | "protobuf"
  | "scss" | "sass" | "less" | "autohotkey" | "autoit" | "applescript";

export interface ExtractorWarning {
  /** Dotted-path location, e.g. "functions[3].endLine" or "routes[0].kind". */
  field: string;
  message: string;
}

/**
 * Where a class/interface name is used. Distinct from CallInfo — these are
 * type-position references (parameter types, return types, field types,
 * extends/implements, generic args, casts, instantiations, variable
 * annotations), not function invocations.
 */
export type TypeUsageKind =
  | "extends"
  | "implements"
  | "parameter"
  | "return"
  | "field"
  | "variable"
  | "generic-arg"
  | "cast"
  | "instantiation";

export interface TypeReference {
  /** The original type token as it appeared in source (e.g. "Promise<User>"). */
  rawType: string;
  /** Bare identifier after stripping generics, optionals, arrays, etc. */
  typeName: string;
  usageKind: TypeUsageKind;
  /** Resolved to a project file when typeName matches a ClassInfo elsewhere. */
  resolvedTargetFile?: string;
  sourceFile: string;
  sourceLine: number;
  /** Containing symbol — "ClassName.method", "functionName", or "(top-level)". */
  sourceSymbol: string;
  /**
   * The class that contains this reference, if any. Lets the Type View
   * render a class→class graph directly. Empty for references made from
   * top-level functions or module-scope code.
   */
  sourceClass?: string;
  /** EXTRACTED for direct annotations, INFERRED for new-expr / heuristics,
   *  AMBIGUOUS when multiple files define a class with this name. */
  confidence?: Confidence;
}

/** Per-file breakdown of how a single class is used inside that file. */
export interface TypeUsageByFile {
  filePath: string;
  /** Total references in this file. */
  count: number;
  /** Reference count split by usage kind for this specific file. */
  byKind: Partial<Record<TypeUsageKind, number>>;
  /** Source-symbol → line numbers for jumping to specific sites. */
  sites: Array<{ symbol: string; line: number; kind: TypeUsageKind }>;
}

export interface TypeUsageSummary {
  /** Class/interface name being summarised. */
  typeName: string;
  /** Where the class is defined (always inside the BlastRadiusInfo's filePath). */
  definedAt: { line: number; isInterface: boolean };
  /** Reference counts grouped by usage kind, aggregated across all files. */
  usageByKind: Partial<Record<TypeUsageKind, number>>;
  /** Total reference count across all kinds. */
  totalUsages: number;
  /** Distinct files that contain at least one usage. */
  usedByFiles: string[];
  /**
   * Per-file usage breakdown. Each entry shows how many references that file
   * makes and which kinds they are. Sorted by count desc — top-impact callers
   * first. This is what the report uses to answer "where is User used as a
   * return type, specifically?".
   */
  usagesByFile: TypeUsageByFile[];
  /** Same scoring scheme as the existing BlastRadiusInfo. */
  impactScore: number;
  level: "critical" | "high" | "medium" | "low";
  changeRisk: "safe" | "moderate" | "dangerous";
}

/**
 * Class-level dependency graph derived from TypeReferences. Used by the
 * Architecture tab's "Data Models" mode toggle — answers "what does
 * changing this class touch?" visually.
 */
export interface ClassGraphNode {
  /** Unique id. For classes: "filePath::className". For file sources:
   *  "file::filePath". For external types: "::typeName" (empty owning file). */
  id: string;
  /** Human-readable name (class name, file basename, or external type name). */
  name: string;
  /** Where the entity lives (relative path). Empty for external types. */
  filePath: string;
  /** Heuristic — interface-like (no methods, has properties). */
  isInterface: boolean;
  /** True when the type is referenced but never declared in the project. */
  isExternal: boolean;
  /** True when the node is a file that emits class-targeting references
   *  from non-class code (top-level functions, Vue setup blocks, etc.). */
  isFile: boolean;
  /** True when this class carries an `["entity", <orm>]` decorator — i.e. it
   *  is an ORM entity that also appears as a node in the ER diagram. Lets the
   *  Data Models view distinguish DB-backed entities from plain models/DTOs. */
  isEntity?: boolean;
  /** ORM tag for entity nodes ("prisma" | "typeorm" | …); null/undefined otherwise. */
  orm?: string | null;
  /** Total inbound references to this entity (degree-in). */
  inboundCount: number;
  /** Total outbound references from this entity (degree-out). */
  outboundCount: number;
}

export interface ClassGraphEdge {
  /** Source class id (the class containing the reference). */
  source: string;
  /** Target class id (the class being referenced). */
  target: string;
  /** Per-kind reference counts on this edge. */
  byKind: Partial<Record<TypeUsageKind, number>>;
  /** Sum across kinds. */
  total: number;
  /**
   * Category derived from byKind, used by the renderer to colour the edge:
   *   - "inheritance" — extends, implements (strongest coupling)
   *   - "data" — field, variable, generic-arg (data composition)
   *   - "function" — parameter, return, cast, instantiation (signature usage)
   * Picked by max-weight kind on the edge.
   */
  category: "inheritance" | "data" | "function";
}

export interface ClassGraph {
  nodes: ClassGraphNode[];
  edges: ClassGraphEdge[];
}

/**
 * Entity-relationship graph for the report's "Data Model" (ER diagram) view.
 * Nodes are ORM entities / SQL tables / enums (from entity-decorated
 * `ClassInfo`); edges are derived from `entityRelations`, with mirror pairs
 * merged into one relationship carrying crow's-foot multiplicity at each end.
 */
export interface EntityGraphColumn {
  name: string;
  /** The physical column, where it differs from `name` (`PropertyInfo.column`). */
  column?: string;
  type: string | null;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

/**
 * A data/view model (class, interface, DTO) that references an entity in type
 * position (field/variable/generic-arg). Derived by joining the ClassGraph
 * onto the EntityGraph by name — see `linkEntityModels` in entity-graph.ts.
 */
export interface EntityModelRef {
  /** ClassGraph node id of the referencing model (`${filePath}::${name}`). */
  id: string;
  name: string;
  filePath: string;
  /** Heuristic interface-vs-class hint carried over from the ClassGraph node. */
  isInterface: boolean;
  /** Data-position usage kinds backing the link (field, variable, generic-arg). */
  kinds: TypeUsageKind[];
  /** Total data-position references from this model to the entity. */
  count: number;
}

export interface EntityGraphNode {
  /** `${filePath}::${name}` — unique even when two files define the same name. */
  id: string;
  name: string;
  /** The physical table, when the ORM names one other than `name` (ClassInfo.tableName). */
  table?: string;
  /** Originating ORM / source, e.g. "prisma" | "typeorm" | "sql". */
  orm: string | null;
  kind: "entity" | "enum";
  filePath: string;
  columns: EntityGraphColumn[];
  line: number;
  /** Data/view models that hold this entity in type position. Omitted when none. */
  referencingModels?: EntityModelRef[];
}

export interface EntityGraphEdge {
  /** Source/target node ids, in canonical (sorted) orientation. */
  source: string;
  target: string;
  /** Multiplicity at each end ("one" or "many") — drives crow's-foot notation. */
  sourceCardinality: "one" | "many";
  targetCardinality: "one" | "many";
  /** Navigation field name(s) backing the relationship. */
  fields: string[];
  /** Owning-side foreign-key column, when known. */
  foreignKey?: string | null;
  /** Join/through/pivot table for many-to-many relationships, when named. */
  joinTable?: string | null;
  orm?: string | null;
  confidence?: Confidence;
  /** True for a self-referential relationship (source === target). */
  selfRef?: boolean;
}

export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
}

/**
 * Project-wide data-access graph. One synthetic "datastore" node per unique
 * data-source target (e.g. `@prisma/client`, `Microsoft.EntityFrameworkCore`,
 * `../lib/prisma`), plus one node per file that performs DB calls. Edges
 * carry the actual call sites so the UI can render per-edge detail.
 */
export interface DataAccessNode {
  /** Unique id. For files: `file::<path>`. For datastores: `db::<target>`.
   *  For entities: `entity::<target>::<entity>`. For queues: `queue::<target>`. */
  id: string;
  /** Display name (file basename, datastore target, or entity/table name). */
  name: string;
  /** "file" for caller files; "datastore" for synthetic DB sinks;
   *  "entity" for a specific table/model under a datastore;
   *  "queue" for message-broker destinations (exchange/queue/topic) —
   *  publish edges point file→queue, consume edges queue→file. */
  kind: "file" | "datastore" | "entity" | "queue";
  /** File path for "file" nodes. Empty for datastore/entity nodes. */
  filePath: string;
  /** Number of incoming edges (only meaningful for datastore nodes). */
  inboundCount: number;
  /** Number of outgoing edges (only meaningful for file nodes). */
  outboundCount: number;
}

export interface DataAccessEdgeCall {
  /** Call expression as captured (e.g. `prisma.user.findMany`). */
  name: string;
  line: number;
  /** Resolved entity/table this call touches (e.g. `user`), when derivable. */
  entity?: string;
}

export interface DataAccessEdge {
  /** Source file node id. */
  source: string;
  /** Target datastore node id. */
  target: string;
  /** Individual call sites that produced this edge. */
  calls: DataAccessEdgeCall[];
  /** Sum of `calls.length`. Surfaced for fast edge-weight sorting. */
  total: number;
}

export interface DataAccessGraph {
  nodes: DataAccessNode[];
  edges: DataAccessEdge[];
}

/** Per-file analysis result */
export interface FileAnalysis {
  filePath: string;
  language: Language;
  frameworks: string[];
  /** ID of the sub-project this file belongs to (see SubProject). "root" if none. */
  projectId: string;

  /**
   * Set ONLY when tree-sitter parsing failed and extraction silently fell back
   * to regex. A fallback result is indistinguishable from a first-class regex
   * language on disk — no complexity rows, coarser calls, no AST routes — so
   * without this marker a broken or missing grammar degrades every file of that
   * language with no signal at all. Absent means the normal path ran (which
   * path that was is derivable from `language` plus the plugin registry).
   */
  extraction?: {
    method: "regex";
    fallback: true;
    /** Closed set: raw error text carries absolute grammar paths and would churn fixtures. */
    reason: "grammar-unavailable" | "null-tree" | "parser-error";
  };

  /**
   * Physical line count of the source file. Feeds file-size signals (refactor
   * pressure, context burden) without re-reading the file. Absent on artifacts
   * written before extractor 1.50.
   */
  lineCount?: number;
  /** Syntax errors the parser recovered from — the file was read only in part. Absent for a clean parse. */
  parseErrors?: { nodes: number; missing: number; ratio: number };

  /**
   * Package names the file uses by path without importing them — Rust's
   * `serde_json::to_string(…)` with no `use serde_json`. Counted as uses by the
   * package inventory only; they name no file and add no edge.
   */
  packageReferences?: string[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  routes: RouteInfo[];
  /** Routing facts for the plugin's project-level route resolver (see `RouteFact`). */
  routeFacts?: RouteFact[];
  /**
   * What this file's handler taint pass hands the project pass
   * (`core/cross-file-taint.ts`): which parameters of its functions reach a
   * sink, and its handlers' calls into other files with request input in them.
   */
  taintFacts?: TaintFacts;
  /**
   * Calls that hand a path literal to a project function (`createFetchHandler(
   * 'system.status', '/system/status')`): a request FACTORY whose own api-call
   * builds its URL from that parameter. The project pass substitutes the
   * literal into the factory's URL at this call site.
   */
  pathArgCalls?: PathArgCall[];
  /**
   * Listeners a page script binds to elements by selector
   * (`document.querySelectorAll("button[data-delete]").forEach(b => b.addEventListener("click", deleteClub))`).
   * Joined to the elements of the pages that load the script, whose
   * `InteractiveElementInfo.selector` they match.
   */
  domBindings?: DomBinding[];
  /**
   * `new X("rooms")`: project classes constructed with a string argument — a
   * generic client configured per instance, as a subclass configures it
   * through `super("rooms")`. The project pass reads the class's requests
   * once per instance, with these arguments.
   */
  instantiations?: Instantiation[];
  /**
   * String values this module defines at its top level, by name — an
   * object's members as `name.member` (`environment.apiUrl` →
   * `http://localhost:5000/api/`), a Go package's constants (`ApiUri` →
   * `/api/v1`). A value may hold `${…}` holes for names it is built from. A
   * project pass (`core/module-values.ts`) follows an import here to resolve
   * `${environment.apiUrl}` in another file's URL, a route prefix or a
   * `DataSourceInfo.targetRef`. Plugins keep what can name an endpoint or a
   * channel, not every string.
   */
  moduleValues?: Record<string, string>;
  /**
   * URL-holding markup attributes a script reads (`el.getAttribute('data-url')`,
   * `el.dataset.updateUrl`), with the verb its function requests it with when
   * the function names one. Markup elements carrying such an attribute make
   * that request (`InteractiveElementInfo.request.attribute`).
   */
  attributeReads?: Array<{ attribute: string; method?: string; line: number }>;
  dataSources: DataSourceInfo[];
  dataMutations: DataMutationInfo[];
  /**
   * Named string constants defined in this file (`#define CUE_TABLE "cues"`,
   * `const QString kTable = QStringLiteral("x")`). Project-level enrichment
   * resolves macro-valued dataSource targets/entities through the union of
   * these maps (a DAO's table macro is usually defined in its header).
   * Omitted when empty.
   */
  stringConstants?: Record<string, string>;
  subComponents: SubComponentInfo[];
  interactiveElements: InteractiveElementInfo[];
  /**
   * Nested component tree mirroring the frontend template's element nesting
   * (with `repeated` set on looped nodes). Populated for frontend files
   * (Vue/React/Svelte/Angular); empty/absent otherwise. `buildScreen` consumes
   * it to reproduce real nesting instead of the flat sub-component fallback.
   */
  templateTree?: TemplateComponentNode[];
  /**
   * For an Angular `@Component` that references an EXTERNAL template
   * (`templateUrl: './x.component.html'`) instead of an inline `template:`
   * string — the raw url. A project-level pass reads the sibling .html and
   * back-fills this component's `interactiveElements`/`templateTree` from it
   * (the per-file pass can't, as it never sees sibling files). Omitted for
   * inline-template or non-Angular files.
   */
  angularTemplateUrl?: string;
  /**
   * Custom-element (Web Component) registrations in this file, so the component
   * graph can resolve `<kebab-tag>` markup usages to the file that defines them.
   * Omitted when the file registers none.
   */
  customElements?: CustomElementDef[];
  /**
   * Members this file gives every component instance (`app.config.globalProperties.$session = $session`,
   * `Vue.prototype.$api = api`): `this.$session` in any component is this file's binding of that name.
   */
  globalMembers?: GlobalMemberDef[];
  /**
   * Project paths this file names as string DATA rather than importing —
   * `import.meta.glob("./pages/*.vue")`, `new URL("./worker.ts",
   * import.meta.url)`, a jest config's `"<rootDir>/setup.ts"`. The toolchain
   * loads them, so reachability (dead-code analysis) follows them; nothing
   * else does, since they are not dependencies in the import sense. Specs as
   * written (globs allowed), resolved by the language plugin's
   * `reachability` model. Omitted when the file names none.
   */
  pathReferences?: string[];
  events: EventInfo[];
  screens: ScreenInfo[];
  /** Schema-validation warnings produced by validateFileAnalysis(). Omitted when empty. */
  extractorWarnings?: ExtractorWarning[];
  /**
   * Per-file complexity rows (one per function/method). Persisted so an
   * incremental run can reconstruct the project-level aggregates from cached
   * FileAnalysis JSON without re-parsing.
   */
  complexities?: ComplexityInfo[];
  /** Per-file security findings — persisted for the same reason as `complexities`. */
  securityIssues?: SecurityIssue[];
  /**
   * Minified or bundled build artifact (webpack output, `*.min.js`-shaped
   * content) — not authored source. Project-level detectors (duplicates,
   * patterns, health) exclude these files the way they exclude generatedRoots.
   */
  minified?: boolean;
  /**
   * Opens with a third-party license/attribution header — vendored source
   * committed into the repo. Only honored at aggregation when such files are
   * a small minority (open-source repos stamp a license on every authored
   * file — that must not disable their scanning).
   */
  vendored?: boolean;
  /**
   * Opens with a generated-code marker — Go's `// Code generated … DO NOT
   * EDIT.`, .NET's `<auto-generated>`, `@generated`, a Java `@Generated`
   * class. Excluded from the quality signals like a generated file name
   * (`isGeneratedFile`); its facts stay.
   */
  generated?: boolean;
  /**
   * Type-position references emitted from this file (class extends/implements,
   * parameter/return/field/variable types, generic args, casts, `new`
   * expressions). Used by `data-model-blast` to compute per-class blast
   * radius. Persisted so the incremental cache works without re-parsing.
   */
  typeReferences?: TypeReference[];
  /**
   * ORM entity relations for entities defined in this file (associations /
   * foreign keys with cardinality), emitted by the language `entities`
   * extractor. Omitted when empty. Persisted for the incremental cache.
   */
  entityRelations?: EntityRelation[];
  /**
   * Tables parsed from a Rails `db/schema.rb`. Only set on the schema file
   * itself; a project-level join attaches these columns to the model entities
   * (whose own class bodies declare no columns). Omitted for non-schema files.
   */
  railsSchemaTables?: RailsSchemaTable[];
  /**
   * Schema changes this file states, in source order — a migration's CREATE /
   * ALTER / DROP / RENAME. The plugin's project pass replays a migration chain
   * from them into one schema (see `SchemaOp`).
   */
  schemaOps?: SchemaOp[];
  /**
   * Dependency-injection container registrations made in this file
   * (`services.AddScoped<IRepo, SqlRepo>()`, `$this->app->bind(I::class,
   * Impl::class)`, `{ provide: TOKEN, useClass: Impl }`, a Spring `@Service`
   * implementing an interface). The symbol linker uses them to send a call
   * through an injected interface to the implementation the container
   * actually builds. Omitted when the file registers none.
   */
  diBindings?: DiBinding[];
  /**
   * Type aliases the file declares (TypeScript `type Repo = ClubRepository`,
   * Go `type Repo = store.ClubRepo`, C# `using Repo = League.ClubRepository;`,
   * Rust `type Repo = Arc<dyn ClubStore>;`, Python `Repo = ClubRepository` /
   * `Repo: TypeAlias = …`), the aliased type as written. The symbol linker
   * follows them where a receiver's declared type names the alias. Omitted
   * when the file declares none.
   */
  typeAliases?: TypeAliasInfo[];
  /**
   * The namespace the file's free functions are declared in, as the language
   * writes it (PHP `namespace App\Support;` → `App\Support`). A call reaching
   * a function by its qualified name (`use function App\Support\money`,
   * `\App\Support\money()`, or a bare `money()` inside that namespace) is
   * joined on it. Omitted for the global namespace.
   */
  declaredNamespace?: string;
  /**
   * The package or namespace the file's declarations belong to, as the
   * language writes it (Scala `package league.clubs`, chained clauses joined;
   * C# `namespace League.Clubs;`). Where imports name packages rather than
   * files (`LanguagePluginManifest.importsNamePackages`), the linker reads an
   * import as the files declaring that package. Omitted when the file declares none.
   */
  packageName?: string;
  /**
   * HTTP client instances this file creates with a base URL, by variable name
   * → the base's PATH (`const apiClient = axios.create({ baseURL: "/api" })`
   * → `{ apiClient: "/api" }`; a full URL keeps only its path). Calls through
   * the client name the path relative to it (`apiClient.get("/users")` asks
   * for `/api/users`). Omitted when the file creates none.
   */
  httpClientBases?: Record<string, string>;
  /**
   * State-store modules this file registers by name (Vuex `modules: { contacts }`
   * in `createStore({…})` or in a module's own definition): the namespace a
   * dispatch key starts with → the identifier holding the module, as written.
   * A dispatch resolver follows the identifier through the file's imports.
   */
  storeModules?: Array<{ name: string; ref: string; line: number }>;
  /**
   * Handlers this file registers under a message name — a command bus, an FFI
   * event (`AFPlugin::new().event(FolderEvent::CreateView, create_view_handler)`),
   * an IPC channel. `message` is written as the registration names it
   * (`FolderEvent::CreateView`); `handler` is the function, as written. A
   * dispatch resolver joins senders of the message to the handler.
   */
  messageHandlers?: Array<{ message: string; handler: string; line: number }>;
  /**
   * HTTP clients configured with a base URL in this file, the host included
   * (`httpClientBases` keeps only the path): typed and named .NET clients,
   * `axios.create({ baseURL: process.env.X })`.
   */
  /** Entry points that are not routes: MCP tools, editor and CLI commands (`EntryPointInfo`). */
  /**
   * Infrastructure the file's code declares (an AWS CDK stack's queues, topics, tables, buckets, databases and
   * Lambdas, with the grants, event sources and env that join them) — merged into `ProjectAnalysis.deployment`
   * beside compose, Kubernetes and Terraform.
   */
  deployedResources?: DeployedResourceFact[];
  entryPoints?: EntryPointInfo[];
  httpClientRegistrations?: HttpClientRegistration[];
  /** Forwarding rules this file declares (a `vite.config.ts` `server.proxy`, `setupProxy.js`). */
  proxyRules?: ProxyRule[];
  /** API-client generators this file configures (`kubb.config.ts`): the spec each reads and where it writes. */
  generatedClients?: GeneratedClientConfig[];
}

/**
 * An API-client generator's configuration: the spec it reads and the
 * directories it writes one module per operation into. Those modules are
 * build output and usually gitignored, so this is the only in-repo statement
 * of what an import from them calls; the plugin's project pass turns a call
 * of such an import into the spec operation it requests. Paths are
 * project-relative and posix, without a trailing slash.
 */
export interface GeneratedClientConfig {
  /** The generator, as the plugin names it (`kubb`). */
  generator: string;
  /** The spec the operations come from (`web/api.json`). */
  spec: string;
  /** The output root every directory below sits in — also the barrel that re-exports them all. */
  root: string;
  /** What each output directory holds: request functions, or hooks wrapping them. */
  outputs: Array<{ dir: string; kind: "client" | "hook" }>;
  line: number;
}

/**
 * One dependency-injection registration: asking the container for `service`
 * yields an instance of `implementation`.
 *
 * Names are bare simple type names (`IUserRepository`, not
 * `App\Repo\IUserRepository`) so they compare with `ClassInfo.name`; a
 * registration keyed by a token instead of a type (`provide: USER_REPO`,
 * `TYPES.UserRepo`, `"userRepo"`) keeps the token's source text as `service`,
 * and the injection point names the same token as its `qualifier`.
 */
export interface DiBinding {
  /** What is requested: a type name or a token. */
  service: string;
  /** The class the container constructs (or the service it aliases — resolved transitively). */
  implementation: string;
  line: number;
  /**
   * The name this registration answers to besides its type — a Spring bean
   * name, a `@Named("x")`, a .NET service key. An injection point carrying the
   * same `qualifier` selects it.
   */
  qualifier?: string;
  /**
   * Reachable ONLY through its qualifier (a .NET keyed service, a Guice
   * `annotatedWith`, a Dagger `@Named` binding): an unqualified injection
   * point never receives it.
   */
  keyedOnly?: boolean;
  /** Wins when several registrations match (Spring `@Primary`). */
  primary?: boolean;
  /**
   * The container falls back to matching the injection point's member name
   * against `qualifier` when the type alone is ambiguous (Spring autowiring:
   * a `Notifier mailNotifier` parameter receives the `mailNotifier` bean).
   */
  matchesMemberName?: boolean;
  /** Applies only when injected into this class (Laravel contextual binding). */
  consumer?: string;
  /**
   * A default that yields to any other registration of the same service:
   * .NET `TryAdd*` (whatever order, a plain `Add*` of the service wins),
   * Autofac `PreserveExistingDefaults()`, Guice `@ImplementedBy` (used only
   * without an explicit `bind`).
   */
  ifAbsent?: boolean;
  /**
   * Exposed under EVERY interface `implementation` has (Autofac
   * `AsImplementedInterfaces()` on a class declared in another file, a Spring
   * bean whose interfaces come from its base class): `service` is ignored and
   * the linker expands the registration from the class's declaration and its
   * project base types — project-defined interfaces only.
   */
  allInterfaces?: boolean;
  /** How the registration was written — `AddScoped`, `bind`, `@Bean`, `@Service` — for display. */
  via: string;
}

export interface ImportInfo {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  isType: boolean;
  line: number;
  /**
   * The file is RUN as a program of its own (`./scripts/build.sh`, PowerShell
   * `& .\deploy.ps1`), not loaded: a dependency, but none of its names come
   * into the importer's scope. Absent for a real import.
   */
  executes?: true;
  /**
   * Loaded on demand (`import("./x")`, usually lazy loading), not when the
   * importer loads: a cycle it closes has no load-order consequence.
   * Absent for a static import.
   */
  dynamic?: true;
  /**
   * A named import bound under another local name (`import { addPlayer as signPlayer }`):
   * local → exported. `specifiers` lists the local name only; the module defines
   * the exported one.
   */
  aliases?: Record<string, string>;
  /**
   * The names this import binds that nothing else in the file mentions, for a
   * language whose plugin can tell (JS/TS). Absent when every name is used,
   * or when the file holds markup (a Vue / Svelte template) the check cannot read.
   */
  unused?: string[];
}

/**
 * Something invoked by name that is not an HTTP route: an MCP tool an agent
 * calls, an editor command, a language-model tool, a CLI subcommand.
 */
export interface EntryPointInfo {
  /**
   * `scheduled-job`: run by a clock (cron, an interval, a recurring job), read by the language's plugin.
   * `message-consumer`: run when a message arrives — derived in core from the queue-consume data access,
   * so every language whose plugin reports a consumer has one.
   */
  kind: "mcp-tool" | "editor-command" | "lm-tool" | "cli-command" | "scheduled-job" | "message-consumer";
  /** As it is invoked: the tool name, the command id, the subcommand; a job's id or handler; the queue or topic consumed. */
  name: string;
  /** The function that runs, when the registration names one (an inline handler has none). */
  handler?: string;
  line: number;
  /** What registers it: `mcp`, `vscode`, `commander`, `yargs`, `click`, `typer`, `node-cron`, `spring`, … */
  framework?: string;
  /** `scheduled-job`: when it runs, as written — a cron expression, `every 5 minutes`, `fixedRate=60000`. */
  schedule?: string;
}

export interface ExportInfo {
  name: string;
  kind:
    | "function"
    | "class"
    | "variable"
    | "type"
    | "interface"
    | "enum"
    | "default"
    | "re-export";
  line: number;
  /**
   * Re-exports only: the module the name is forwarded from, as written
   * (`export { x } from "./y"` → "./y"). `export * from "./y"` is recorded as
   * name "*". Absent on a local `export { x }`, which also has kind
   * "re-export" but forwards nothing.
   */
  source?: string;
  /**
   * The name inside `source` when the re-export renames it (`export { a as b } from` → "a"), or the
   * local binding a renamed local export stands for (`export { del as delete }` → "del").
   */
  sourceName?: string;
}

/** A type alias a file declares: `name` stands for `type`, as written. */
export interface TypeAliasInfo {
  name: string;
  type: string;
  line: number;
  /** Means the name only inside its own file (a C# `using A = B;` that is not `global`). */
  fileScoped?: boolean;
}

export interface ParamInfo {
  name: string;
  type: string | null;
  defaultValue: string | null;
  /**
   * What a dependency-injection container is asked for when it is not the
   * declared type alone: the token or key on the parameter
   * (`@Inject(USER_REPO)`, `@Qualifier("mailNotifier")`, `@Named("x")`,
   * `[FromKeyedServices("k")]`). Matched against `DiBinding.service` /
   * `DiBinding.qualifier`. Omitted when the parameter carries none.
   */
  qualifier?: string;
  /**
   * The receiver of an extension method — C# `this BandBase band`, a Kotlin
   * `fun Band.f()` receiver: the method is called as `band.f()` on that type
   * although no class of it declares `f`. Omitted otherwise.
   */
  isReceiver?: boolean;
  /**
   * The DI container supplies this parameter although it is not a
   * constructor's: a Laravel/Symfony controller action, ASP.NET
   * `[FromServices]`, FastAPI `Depends()`, a Spring `@Bean` method's
   * parameters. Container registrations decide such a parameter's
   * implementation; an ordinary method parameter is whatever the CALLER
   * passes, and registrations never apply to it. Omitted otherwise.
   */
  injected?: boolean;
  /** Takes any number of trailing arguments (Java `String... a`, C# `params T[] a`, TS `...rest`, PHP `...$rest`). */
  variadic?: boolean;
  /** A caller may leave it out without a default standing in (TypeScript `b?: number`). */
  optional?: boolean;
}

/**
 * Provenance of an extracted relation:
 *   EXTRACTED — directly observable in source (import statement, exact name match, known pattern)
 *   INFERRED  — derived via a heuristic or second-pass resolver (LSP, name-shape rules, injection)
 *   AMBIGUOUS — multiple candidates matched or resolver fell back to a loose guess
 */
export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface CallInfo {
  name: string;
  kind: "cross-file" | "database" | "api-call" | "internal";
  target: string | null;
  line: number;
  column?: number;
  confidence?: Confidence;
  /**
   * The FACTORY function this call's receiver was bound from, when the
   * binding is visible (`const m = useAddLicenseMutation(...)` →
   * `m.mutateAsync(...)` carries via:"useAddLicenseMutation"). When the call's
   * leaf doesn't exist in the target module (the member lives on a
   * library-made object — a tanstack mutation, an event emitter), the symbol
   * linker falls back to linking the factory itself, which is where the
   * meaningful project code (mutationFn → service call) sits.
   */
  via?: string;
  /**
   * The type the call's receiver is, when the call expression itself says
   * so and no field, parameter or local does — a service-locator lookup
   * chained straight into the call (`app(Mailer::class)->send()`,
   * `sp.GetRequiredService<IMailer>().Send()`, `getIt<Mailer>().send()`).
   * The linker resolves it exactly like an injected field of that type.
   */
  receiverType?: string;
  /** The DI token/key that lookup named, when it named one (`container.get(TYPES.Mailer)`). */
  receiverQualifier?: string;
  /**
   * The string a call dispatches by, when the callee routes on a name rather
   * than calling it (`store.dispatch('contacts/get')`). A dispatch resolver
   * joins it to the handler registered under that name. Set by the plugin's
   * `calls.keyOf` hook; calls of one name with different keys stay separate.
   */
  key?: string;
  /**
   * The call's arguments as written, when the plugin's `calls.argsOf` hook reports
   * them — Delphi does, for a call that passes a component by name
   * (`Fill(qryPupils)`), so a project pass can follow the dataset into the
   * routine's parameter; JS/TS does for a function call handing on a member
   * chain or its own parameter (`useStore("club", api.clubs)`), so the linker
   * can follow a client into the factory that uses it (an argument it does not
   * report is ""). Absent everywhere else.
   */
  args?: string[];
  /**
   * Where the call's arguments come from, when the plugin can tell for at
   * least one (`calls.argOriginsOf`): a literal, the calling function's own
   * parameter, or a value the framework reads off the current URL
   * (`useParams().id`, `this.props.match.params.username`). The project pass
   * `paramOrigins` follows these from an API call's URL back to the screen.
   */
  argOrigins?: CallArgOrigin[];
  /**
   * How many arguments the call passes (Java, Kotlin, C#, TypeScript, Python,
   * PHP): in a language with overloading the linker picks `save(Order)` or
   * `save(Order, boolean)` by it; the patch check compares it with the
   * definitions' parameters. Absent elsewhere and where a spread argument
   * hides the count.
   */
  argCount?: number;
}

/** One argument of a call and where its value comes from (`CallInfo.argOrigins`). */
export interface CallArgOrigin {
  /** Position of the argument, 0-based. */
  index: number;
  origin:
    | { kind: "literal"; value: string }
    /** The calling function's own parameter (`index` among its parameters). */
    | { kind: "param"; name: string; index: number }
    /** A route parameter or query-string value of the current URL, by name. */
    | { kind: "route-param" | "query-param"; name: string }
    /**
     * A parameter of a callback a library calls with what its caller hands
     * one of `via` (TanStack's `mutationFn: ({ id }) => …`, called with what
     * `mutation.mutate(x)` is given): argument `index` of such a call, or its
     * property `field` when the callback destructures it.
     */
    | { kind: "invoked"; via: string[]; index: number; field?: string };
  /** One wrapper the value passed through (`Number`, `encodeURIComponent`, a template literal). */
  transform?: string;
  /**
   * The property of an object-literal argument the value sits at, as a dotted
   * path (`path.id` of `getClub({ path: { id } })`); absent when the argument
   * itself is the value.
   */
  field?: string;
}

/**
 * Which value feeds a parameter of an API call's URL (`ProjectAnalysis.paramOrigins`):
 * the call (`sink`), where its value starts (a route parameter of a screen, a
 * literal, or unknown), the calls it travels through, and the backend route
 * parameter it binds when the call is joined to a route.
 */
export interface ParamOrigin {
  /** The API call and the slot of its URL (`${username}`). */
  sink: { file: string; line: number; url: string; slot: string };
  origin:
    | { kind: "route-param" | "query-param"; name: string; file: string; line: number; screen?: string; routePath?: string; inRoutePath?: boolean }
    | { kind: "literal"; value: string; file: string; line: number }
    | { kind: "unknown"; file: string; line: number };
  /** The functions the value is handed through, from the origin towards the call, each with the argument position (and the property of it, for an object argument). */
  hops: Array<{ file: string; symbol: string; line: number; arg: number; field?: string }>;
  /** The backend route parameter the slot binds, when the call is joined to a route. */
  route?: { file: string; line: number; method: string | null; path: string; param: string; binding?: string; type?: string };
  confidence: Confidence;
}

export interface FunctionInfo {
  name: string;
  params: ParamInfo[];
  /**
   * Takes further arguments `params` does not list (Python `*args` /
   * `**kwargs`, which are no parameters a caller names). Omitted otherwise.
   */
  variadic?: boolean;
  returnType: string | null;
  isAsync: boolean;
  isExported: boolean;
  decorators: string[];
  calls: CallInfo[];
  line: number;
  endLine: number;
  /** The first sentence of its doc comment or docstring, capped (core/doc-comments.ts). Absent when it has none. */
  doc?: string;
  /**
   * Local variables whose type this body states: assigned a constructed
   * instance (`$x = new Foo()` → `{ name: "x", type: "Foo" }`), declared with
   * a type, or fetched from a DI container (`$x = app(Foo::class)`,
   * `var x = sp.GetRequiredService<IFoo>()`). Lets the symbol linker resolve
   * `x.method()` to `Foo.method` without LSP. `qualifier` is the token/key a
   * container lookup named (see `ParamInfo.qualifier`); a lookup by key alone
   * (`ref.read(repoProvider)`) has `type: ""`. Optional; populated only by
   * plugins that extract it.
   *
   * `from`: a local whose initializer is a call that states no type
   * (`val dao = UserDAOFactory.getDAO()`, `$w = IOFactory::createWriter(…)`,
   * `var s = repo.Find(id)`) carries that call as a chain spelled the way
   * `CallInfo.name` spells one, closed by `()` (`UserDAOFactory.getDAO()`;
   * `callChainText` builds it), with `type: ""`. The linker types the local
   * with the call's DECLARED return type — the plugin never infers it.
   * `awaited`: the initializer was awaited (`var s = await repo.FindAsync(id)`),
   * so the local holds what the returned task/promise resolves to.
   */
  localTypes?: Array<{ name: string; type: string; qualifier?: string; from?: string; awaited?: boolean }>;
  /**
   * For a URL-builder helper — a function whose return value is an
   * app-relative request URL assembled from string concatenation / a template
   * (`requestUri(endpoint, version) → /api/{version}/institution/{}/{endpoint}`)
   * — the parameterized URL template: path literals verbatim, each parameter
   * as `{paramName}`, and any unresolvable runtime reference (env base, closure
   * variable) as `{}`. A project-level pass substitutes a call site's literal
   * args so an `axios.get(requestUri('teamtalk','v4'))` api-call gets a
   * concrete URL that joins to the backend route. Optional; only JS/TS sets it.
   */
  urlTemplate?: string;
  /**
   * The expression `urlTemplate` started with before the extractor dropped it
   * as a runtime base (`this.baseUrl()` in `` `${this.baseUrl()}/${this.resource}` ``).
   * A getter read as `this.url` is substituted with it put back, so the base
   * resolves through the class chain instead of being lost.
   */
  urlTemplateBase?: string;
  /**
   * The helper's OTHER url templates, when its body returns a different URL
   * per branch (`isEmployee ? base + "/api/staff/" + p : base + "/api/" + p`
   * → `urlTemplate` `/api/staff/{p}`, alternatives `["/api/{p}"]`). Source
   * order; a branch that only differs in a dropped base is not listed twice.
   * Absent when there is exactly one template.
   */
  urlTemplateAlternatives?: string[];
  /**
   * What this function reads from an HTTP request when it is a route handler
   * whose bindings are not declared in its signature — `req.body.name`,
   * `c.ShouldBindJSON(&input)`, `req.content.decode(T.self)`,
   * `params.require(:user)`. Extracted per file by the plugin from the body;
   * the project-level join (`core/request-schemas.ts`) copies it onto the
   * route that names this function as its handler, so a Go/Express/Vapor
   * route gets `params` although its registration line never shows them.
   */
  requestAccess?: RouteParamInfo[];
  /**
   * What the function answers when it is a request handler (`res.status(201)
   * .json({ id })`, a declared return type) — copied onto a route that names
   * this function as its handler and states no responses of its own.
   */
  responses?: RouteResponseInfo[];
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  visibility: "public" | "private" | "protected" | null;
  isStatic: boolean;
  isReadonly: boolean;
  /**
   * Attributes/annotations on the member, full text with arguments
   * (`Required`, `JsonPropertyName("start_date")`). Optional; populated by
   * plugins that read them (C#), consumed by the request-schema pass.
   */
  decorators?: string[];
  /** Language-level "must be set" marker (C# 11 `required` modifier). */
  isRequired?: boolean;
  /** The DI token/key the field is injected by — see `ParamInfo.qualifier`. */
  qualifier?: string;
  /**
   * A computed member's value as written, when its type is not stated (a
   * Python `@property` returning `self.repos.foods`): the project pass types
   * the member as that chain resolves.
   */
  from?: string;
  /**
   * The arguments of the construction a computed member returns, as written
   * (`return GarageRepo(self.repo, self.logger)` → `["self.repo", "self.logger"]`):
   * what lets a project pass follow a repository handed to a wrapper's
   * constructor into the wrapper's own calls on it. Keyword arguments omitted.
   */
  constructedWith?: string[];
  /**
   * The constructor parameter the member is assigned, when it holds a class
   * (`def __init__(self, model: type[Club]): self.model = model` → `model`):
   * what lets a project pass read the class an instance holds off the
   * arguments each construction passes.
   */
  assignedFrom?: string;
  /**
   * The physical column an ORM entity maps the member to, where the code names
   * one that differs from the member (`@Column(name = "first_name")`).
   */
  column?: string;
  /** An ORM entity member the code declares as (part of) the primary key (`@Id`, `@EmbeddedId`). */
  primaryKey?: boolean;
  /**
   * The member mirrors another schema's member, as its `$ref` is written
   * (`../api-spec/league-api.yaml#/components/schemas/Club/properties/id`): an
   * API contract property copied from the schema it projects. Its type is that
   * member's, which the file does not state.
   */
  ref?: string;
}

export interface ClassInfo {
  name: string;
  /** The first sentence of its doc comment or docstring, capped (core/doc-comments.ts). Absent when it has none. */
  doc?: string;
  /**
   * The physical table an ORM entity maps to, where the code names one that
   * differs from the class (`@Table(name = "app_users")`, `__tablename__`,
   * `@@map`, `db_table`, `[Table("…")]`, `self.table_name`). Raw SQL names the
   * table, so access matching tries it beside the class name.
   */
  tableName?: string;
  extends: string | null;
  implements: string[];
  /**
   * The class's own type parameters in order (`class Handler<TRequest, TKey>` →
   * `["TRequest", "TKey"]`): what lets a consumer substitute a subclass's
   * generic arguments (`class X : Handler<GetQuery, Guid>`) into what the base
   * states with them. Absent on a non-generic class.
   */
  typeParameters?: string[];
  decorators: string[];
  methods: FunctionInfo[];
  properties: PropertyInfo[];
  /**
   * String-shaped values the class gives its fields — an initializer or a
   * constructor's top-level `this.x = …` — rendered with `${…}` holes for
   * what is not literal (`baseUrl` → `${environment.apiUrl}`,
   * `resourceName` → `tags`). A field given two different values is absent.
   * What a project pass needs to resolve `${this.baseUrl}` in a URL. Ruby
   * records the chain an instance variable is assigned (`@agent =
   * agents.find(params[:id])` → `agent: "agents.find(params[:id])"`), which
   * the entity pass reads to type `@agent.update!`.
   */
  fieldValues?: Record<string, string>;
  /**
   * The arguments the class's constructor passes to its superclass's
   * (`super('contacts', { accountScoped: true })`), rendered as `fieldValues`
   * are (`contacts`, `${{ accountScoped: true }}`): what a base-class field set
   * from a constructor parameter (`this.resource = resource`) holds in THIS
   * class. Absent when the constructor makes no such call.
   */
  superArgs?: string[];
  isExported: boolean;
  line: number;
  endLine: number;
  /**
   * "interface" marks abstract types so the linker can route calls to concrete
   * implementations; "enum" marks a closed set of named values (its members
   * are the `properties`), which the request-schema pass renders as a string
   * enum instead of an object.
   */
  kind?: "class" | "interface" | "enum";
  /**
   * On an interface: satisfied STRUCTURALLY — a type implements it by having
   * its methods, never by naming it (every Go interface, a Python `Protocol`).
   * The linker then counts a same-language class whose methods cover this
   * interface's as one of its implementations.
   */
  structural?: boolean;
  /**
   * The types it embeds, whose methods are its own. On a structural interface
   * (Go `type CObject interface { web.CRUDable; web.Permissions }` →
   * `CRUDable`, `Permissions`): one the analysis lacks leaves its method set
   * unknown, and it then matches nothing. On a Go struct: the embedded fields'
   * types, whose methods are promoted.
   */
  embeds?: string[];
}

/** A non-auth filter on a route (`RouteInfo.filters`). */
export interface RouteFilter {
  /** As written: `EnableRateLimiting("fixed")`, `throttle:60,1`, `UsePipes(ValidationPipe)`. */
  text: string;
  kind: "rate-limit" | "cors" | "csrf" | "validation" | "cache" | "transaction" | "logging" | "error" | "other";
  /** Declared on the class, router or group rather than the action. */
  inherited?: boolean;
  /** `false` when the filter switches the protection off (`DisableRateLimiting`, `IgnoreAntiforgeryToken`, `SkipThrottle`). */
  enabled?: false;
}

export interface RouteInfo {
  path: string;
  httpMethod: string | null;
  kind: "frontend" | "api";
  handler: string | null;
  /**
   * The concrete types the handler's receiver is built to work on, as written:
   * Go `h := &handler.WebHandler{EmptyStruct: func() CObject { return &models.Club{} }}`
   * serving `h.ReadOneWeb` names `models.Club`. A generic handler that
   * dispatches on an interface reaches that type's implementation.
   */
  handlerTypes?: string[];
  /**
   * The interface (or class) method this route IS, when the route is declared
   * on a typed API (`@GET @Path(...)` on `PersonRepository#getPerson`). A
   * client proxy of the same interface calls it whatever URL it is mounted at.
   */
  contract?: ApiContract;
  /**
   * For frontend routes: the raw module specifier of the route's `component`
   * (e.g. "./pak.vue" from `component: () => import("./pak.vue")`, or the
   * identifier name for a statically-imported component). Lets the screen
   * builder follow the route to the actual page file instead of treating the
   * route-config file as the screen. Null for API routes or when no component
   * could be identified.
   */
  componentPath?: string | null;
  /**
   * Frontend routes only: the route renders no page of its own but sends the
   * reader on — Vue `redirect`, Angular `redirectTo`, React Router
   * `<Navigate to>` — to this path ("" when the target is computed). Such a
   * route is wiring, never a screen.
   */
  redirectTo?: string;
  /**
   * Frontend routes only: declared where the reader navigates FROM (a SwiftUI
   * `NavigationLink`, a `.sheet`) rather than in a route table — the
   * declaring file's screen opens this one.
   */
  navigation?: true;
  /**
   * API routes only: the route receives a third-party webhook
   * (`core/webhook-routes.ts`) — `provider` from the header it reads, the
   * verification it calls or its path; `verified` true when something it
   * reaches checks the signature (`via` says what), false when everything it
   * reaches is known and nothing does, absent when that cannot be told.
   */
  webhook?: { provider?: string; verified?: boolean; via?: string };
  /**
   * API-contract rows only (a WSDL, an OpenAPI document): the project only
   * CALLS this operation — through a client proxy of the contract's type
   * (`getPort(X.class)`, a generated client) that no class of the project
   * implements, and no code route implements the row. The row stays so the
   * project's contract calls still join it, but it is no route the project
   * serves: route counts, uncalled-route gaps, the API export and an origin
   * that names this project all leave it out (`core/client-proxies.ts`).
   */
  consumed?: true;
  /**
   * The path as written when it names constants the file does not define
   * (`@GetMapping(ApiPaths.CLUB)`, `[HttpGet(ApiRoutes.Club)]`,
   * `@app.route(CLUBS_URL + "/<id>")`): the full path with each such name a
   * `${…}` hole. A project pass (`core/module-values.ts` `resolveRouteTemplates`)
   * sets `path` from it when the defining modules state every hole; otherwise
   * `path` stays what the plugin could read alone.
   */
  pathTemplate?: string;
  calls: CallInfo[];
  /**
   * Guards and filters applied to the route, as readable strings: Express
   * middleware names, ASP.NET `Authorize(Policy=…)` / `AllowAnonymous`
   * attributes (class-level ones inherited by every action). The structured
   * form of the auth subset is `auth`.
   */
  middleware: string[];
  /**
   * API routes, with a coverage report: the lines the tests ran in the handler and the functions it calls
   * (three calls deep), over the functions the report counts. `covered: 0` is a route no test runs.
   */
  testCoverage?: { covered: number; total: number; functions: number };
  /**
   * What else runs around the handler besides auth, by kind: rate limits, CORS, CSRF checks, validation,
   * caching, transactions, logging, error handling — ASP.NET `[EnableRateLimiting]` / `[ValidateAntiForgeryToken]`,
   * NestJS `@UseInterceptors` / `@UsePipes`, Laravel `throttle:60,1`, an Express `rateLimit()` (`inherited`:
   * from the class, router or group). Read off the attributes and middleware names the plugin sees.
   */
  filters?: RouteFilter[];
  line: number;
  /**
   * Who may call the route, when the framework states it declaratively
   * (`[Authorize(Policy = …)]`, `@PreAuthorize`, `@UseGuards`). Absent when no
   * auth attribute is visible on the action or its class — which is "unknown",
   * not "open": a global policy may still apply.
   */
  auth?: RouteAuthInfo;
  /**
   * API versions the route serves, as declared (`[ApiVersion("2")]` → "2",
   * `[ApiVersion(2.0)]` → "2.0"). Absent for unversioned or version-neutral
   * routes. The cross-tier linker uses it to pick the twin that serves the
   * concrete version a client calls (`/api/v3/…`).
   */
  versions?: string[];
  /** Subset of `versions` marked deprecated (`[ApiVersion("2", Deprecated = true)]`). */
  deprecatedVersions?: string[];
  /**
   * The action's parameters with where each binds from in the request. Lets a
   * consumer that CALLS the endpoint know what body, query and route values it
   * takes — the per-file `FunctionInfo.params` has names and types but not the
   * binding.
   */
  params?: RouteParamInfo[];
  /**
   * What the handler answers, as far as it states it: each status with the
   * body's declared type (`Promise<UserDto>`, `ResponseEntity<User>`,
   * `response_model=User`) or the keys of the object literal it sends
   * (`res.status(201).json({ id, name })`). `status` is null when the code
   * is the framework's default and not written. Absent when nothing is visible.
   */
  responses?: RouteResponseInfo[];
  /**
   * A router MOUNT, not an endpoint: `app.use("/api", apiRouter)`,
   * `include_router(x.router, prefix="/users")`. `path` is the prefix and
   * `handler` the router to resolve; the project mount pass prefixes that
   * router's routes and drops this row. Explicit so an "any method" route with
   * an identifier handler (Compojure `ANY`, Express `all`) is never mistaken
   * for one.
   */
  mount?: true;
  /**
   * A mount whose router is loaded where it is mounted, with no binding
   * (`register(require("./clubs"), { prefix })`): the module as written, which
   * the mount pass resolves through the file's imports instead of `handler`.
   */
  mountModule?: string;
  /**
   * The request media types the endpoint accepts, as declared (JAX-RS `@Consumes`): two methods on
   * one method + path that differ only here are two endpoints.
   */
  consumes?: string[];
  /**
   * The router variable or controller class the route is declared on, as
   * written (`router`, `SeriesController`). Lets a project-level pass apply a
   * prefix to one router's routes when a file declares several.
   */
  owner?: string;
  /**
   * An outer prefix exists but could not be resolved, and `path` is only the
   * known tail of what a caller requests. The value names why: `base:X` (an
   * unresolved base controller), `attribute:X` (a routing attribute whose
   * template could not be evaluated), `mount:<expr>` (mounted under a runtime
   * value), `urlconf:not-included`, `property:${x}` (a configuration
   * placeholder the path starts with), `contract:<Type>` (the whole path is
   * declared on an API interface outside the analysis — `path` then names the
   * operation, `MatchApi#getMatch`, and only its `contract` joins). The
   * cross-tier linker matches such a row only as a suffix, and never above a
   * row whose path is complete.
   */
  prefixUnresolved?: string;
  /** Id of the project-level resolver that created or rewrote this row. */
  resolvedBy?: string;
  /**
   * The configured base the project serves its routes under, already in front
   * of `path` (Spring `server.servlet.context-path: /league` → `/league/clubs`),
   * and where it is set.
   */
  basePath?: { path: string; key: string; file: string };
  /**
   * API routes only: further paths the same endpoint answers at, which the
   * cross-tier linker matches like `path` — the URI segments a CodeIgniter
   * method binds as arguments (`/sync/photo/{sync_id}`), an alias a route
   * table maps onto it (`/clubs` → `club/list`). One endpoint, one row.
   */
  aliases?: string[];
  /**
   * The name the framework registers the route under, which templates build its
   * URL from: Laravel `->name('clubs.show')` / `'as' => …` (group prefixes
   * included, `clubs.index` for a resource action).
   */
  name?: string;
}

/** A construction with a string argument (see `FileAnalysis.instantiations`). */
export interface Instantiation {
  /** The class as written. */
  className: string;
  /** Each argument as `ClassInfo.superArgs` renders it: a string's content, else a `${…}` hole. */
  args: string[];
  line: number;
  /** The variable it is assigned to (`const roomService = new …`). */
  name?: string;
}

/** A call passing at least one path literal to a function (see `FileAnalysis.pathArgCalls`). */
export interface PathArgCall {
  /** The callee as written: a function name, or the leaf of a member call. */
  callee: string;
  /** Each positional argument: a string literal's content, else null. */
  args: Array<string | null>;
  /**
   * Each positional argument that is a bare name, as written (`url` in
   * `NewClientRequest(method, url)`), else null: where it is a parameter of
   * the function making the call, that function is itself a factory.
   */
  argNames?: Array<string | null>;
  line: number;
  /**
   * The project class the call is made on, as written (`ApiConnection` in
   * `ApiConnection().request(…)`, `$c = new ApiConnection(); $c->request(…)`):
   * the callee is that class's method, wherever the call sits.
   */
  receiverType?: string;
  /**
   * The object a member call is made on, as written (`signedUrlService` in
   * `signedUrlService.fetch(url)`): the callee is that object's method — a
   * function named `signedUrlService.fetch` in the module the name comes from.
   */
  receiver?: string;
  /**
   * The HTTP verb an argument names (`RequestType.POST`, `Verb::DELETE`,
   * `'GET'`): a wrapper that dispatches on it requests with that method.
   */
  method?: string;
}

/**
 * A routing fact a per-file extractor saw but could not turn into a route on
 * its own — a Django `urlpatterns` entry, a DRF `router.register`, a base
 * controller's route template. Opaque to core: only the emitting plugin's
 * route resolver reads `kind` and `data`. Persisted with the file so an
 * incremental run can reconcile without re-parsing.
 */
export interface RouteFact {
  kind: string;
  line: number;
  owner?: string;
  data: unknown;
}

/** One answer a route handler gives (`RouteInfo.responses`). */
export interface RouteResponseInfo {
  status: number | null;
  /** The body's declared type, as written. */
  type?: string;
  /** The keys of the object literal sent, when the body is one (sorted). */
  keys?: string[];
}

/** Where a route handler parameter is read from. */
export type RouteParamBinding =
  | "body"
  | "query"
  | "route"
  | "header"
  | "form"
  | "services";

export interface RouteParamInfo {
  name: string;
  type: string | null;
  /** Null when neither declared nor inferable. */
  binding: RouteParamBinding | null;
  /**
   * True when `binding` was derived from the framework's default rules (the
   * name appears in the path template; a complex type on an `[ApiController]`
   * binds from the body) rather than an explicit `[FromX]` attribute.
   */
  inferred?: boolean;
  /**
   * The `$ref` the parameter is defined by when that definition lives in a file
   * outside the analysis (an API spec's shared `headers.yaml#/customerId`): the
   * parameter is known to exist, `name` is the ref's last segment, and its real
   * name, binding and type are unknown.
   */
  ref?: string;
}

/**
 * The subset of JSON Schema the request-schema pass emits for a route's body:
 * enough for a caller to build a valid request, small enough to embed per
 * route. `$ref` names a type that was not resolved (or was cut by the depth
 * cap) so the consumer can look it up in `classes` instead.
 */
export interface JsonSchemaNode {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  format?: string;
  nullable?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  $ref?: string;
  enum?: string[];
  additionalProperties?: JsonSchemaNode | boolean;
}

export interface RouteAuthInfo {
  /** Named policies (`Policy = nameof(Permission.ManageSquad)` → "Permission.ManageSquad"). */
  policies: string[];
  /** Required roles (`Roles = "Admin,Editor"` → ["Admin","Editor"]). */
  roles: string[];
  /** Authentication schemes (`AuthenticationSchemes = ClubStaff` → "ClubStaff"). */
  schemes: string[];
  /** `[AllowAnonymous]` — overrides any `Authorize` on the class. */
  anonymous: boolean;
  /** True when every guard came from the enclosing class, none from the action itself. */
  inherited: boolean;
}

/**
 * A resolved frontend→backend link: an outbound `api-call` (from client code)
 * matched to the inbound `api` route that serves it, by HTTP method + a
 * structurally-normalized path (case/separator-insensitive, with both
 * `${param}` template literals and `{param}`/`:param` route params collapsed to
 * a wildcard). This is the keystone of the "screen → API → DB" chain: it joins
 * the two route halves the extractors produce independently. `source`/`target`
 * are project-relative file paths in memory (page_ids on disk).
 */
export interface ApiRouteLink {
  /** Frontend file containing the api-call. */
  source: string;
  sourceLine: number;
  /** HTTP method of the call (GET/POST/…), uppercased; null if not derivable. */
  method: string | null;
  /** Raw outbound target as written in the client (e.g. `/access-report/roles/${roleId}/holders`). */
  url: string;
  /** Backend file declaring the matched route. */
  target: string;
  targetLine: number;
  /** Matched route's handler/action name. */
  handler: string | null;
  /** Matched route's full path (e.g. `/AccessReport/roles/{roleId}/holders`). */
  routePath: string;
  /**
   * The subclasses a base-class method's request was resolved for
   * (`ApiCall.viaSubclass`) whose URL this route serves: one link per call
   * site and route, however many subclasses request it.
   */
  viaSubclasses?: string[];
  /**
   * Sub-project of the calling file and of the route. They differ when one
   * project calls another's API — a frontend its backend, a service another
   * service — which is what a project-level dependency is made of.
   */
  sourceProject?: string;
  targetProject?: string;
  /**
   * EXTRACTED — method + path matched exactly (one route).
   * INFERRED  — path matched but method differed/was unknown.
   * AMBIGUOUS — more than one route matched; `target` is the first.
   */
  confidence: Confidence;
  /**
   * How the path was matched, which `confidence` alone cannot tell you.
   *
   * `exact` and `method-fallback` are the difference between "this route serves
   * this call" and "some route at this path does"; `base-prefix:<p>` means the
   * two sides disagreed about a proxy base (`/api`) and names the prefix that
   * reconciled them — the one piece of evidence needed to judge whether the
   * match is real or an artefact of the default prefix list. `version-mismatch`
   * means the client named a concrete API version (`/api/v5/`) that no route
   * at that path declares serving; `target` is the best remaining guess.
   */
  matchedVia?:
    | "exact"
    | "method-fallback"
    | "version-mismatch"
    /** A runtime segment of the call (`/api/{version}/x`) read as the route's API version. */
    | "version-assumed"
    | `base-prefix:${string}`
    | "base-unresolved"
    | `base-unresolved:${string}`
    | "route-prefix-unresolved"
    | `service:${string}`
    | "contract";
  /**
   * Where the calling file sits, when it is not production code: a `test`
   * (spec, e2e, integration test) or `generated` (an SDK, a bundle). The link
   * is real — the test does request that route — but "which screen calls this
   * endpoint" is about production callers, so consumers count them apart.
   * Absent = production.
   */
  sourceRole?: "test" | "generated";
}

/** What the cross-tier linker did with every outbound call, including what it refused. */
export interface ApiRouteLinkStats {
  calls: number;
  /** Calls with at least one URL naming an app path. */
  joinable: number;
  linked: number;
  refused: {
    /** Routes existed at the path, but none serves the call's method (or any method). */
    methodMismatch: number;
    /** Every URL was wildcards only (`/{}/{}`) — it names no route. */
    wildcardOnly: number;
    /** Only a suffix could match (unknown base or route prefix), and several routes did. */
    ambiguousSuffix: number;
    /**
     * The call's origin names a service, and no route of that service matches
     * — never retried on another service's routes. Often the most interesting
     * row: a route renamed or removed on one side only.
     */
    originMismatch?: number;
  };
  /** Joinable calls no route matched at all. */
  unmatched: number;
  /** Links whose call and route are in different sub-projects. */
  crossProject?: number;
  /**
   * Calls whose only URLs are absolute and name another host
   * (`http://orders:8080/api/orders`). Not joinable: which project serves that
   * host is not known from the path.
   */
  otherHost?: number;
  /** Calls whose URL sits behind a base nobody resolved (`baseExpr`), linked or not. */
  unresolvedBase?: number;
  /** Links by the role of the calling file. */
  byRole?: { production: number; test: number; generated: number };
  /**
   * The joinable calls that reached no route, each with why — the list behind
   * `unmatched` and `refused` (capped; the counts stay exact). A backend that
   * renamed `/invoices/export` to `/invoices/download` shows up here as the
   * frontend call that still asks for the old path.
   */
  misses?: ApiCallMiss[];
  /**
   * API routes no call in the repository reaches, in the sub-projects some
   * in-repo client does call (a service only external clients call would list
   * every route). Capped; `uncalledCount` is exact.
   */
  uncalled?: Array<{ file: string; line: number; method: string | null; path: string }>;
  uncalledCount?: number;
}

/**
 * A disagreement between the body a call sends and the body its route
 * declares (see `checkContracts`), on an EXTRACTED link. `field` is dotted
 * for a nested field (`address.city`).
 */
export interface ContractFinding {
  file: string;
  line: number;
  method: string | null;
  url: string;
  route: { file: string; line: number; path: string };
  /**
   * `unknown-response-field`: the call reads a field off the response that
   * the route's closed response body does not send.
   */
  kind: "missing-field" | "unknown-field" | "type-mismatch" | "unknown-response-field";
  field: string;
  /** The declared type (`type-mismatch`). */
  expected?: string;
  /** The type the call sends (`type-mismatch`). */
  actual?: string;
}

/** A call the route linker could not join (`ApiRouteLinkStats.misses`). */
export interface ApiCallMiss {
  file: string;
  line: number;
  method: string | null;
  url: string;
  reason: "unmatched" | "method-mismatch" | "origin-mismatch" | "ambiguous-suffix";
  /**
   * The routes that DO serve this path, refused for the reason given: the
   * other methods of a `method-mismatch` ("the backend accepts PUT"), another
   * service's routes for an `origin-mismatch`. At most three.
   */
  existing?: Array<{ method: string | null; path: string; file: string; line: number }>;
}

/**
 * One sub-project depending on another at runtime: requests (`http`, an
 * api-call joined to the route serving it) or messages (`bus`, a publish
 * matched to its consumer) cross from `from` to `to`. Import coupling is not
 * an edge here — that is the component graph.
 */
export interface ProjectDependency {
  /** Sub-project ids (see `SubProject.id`). */
  from: string;
  to: string;
  kind: "http" | "bus";
  /** Links behind the edge — test callers and AMBIGUOUS links excluded. 0 = only deployment states it. */
  links: number;
  /** Those links by confidence. */
  confidence: Partial<Record<Confidence, number>>;
  /**
   * What crosses the edge, most-linked first: `GET /api/orders` (http) or a
   * broker destination (bus). Capped; `endpointCount` is the total.
   */
  endpoints: Array<{ name: string; links: number }>;
  endpointCount: number;
  /**
   * A compose/k8s edge between the two projects' services states the same
   * dependency: the env var that evidenced it on the caller's service, and the
   * manifest declaring that service.
   */
  deployment?: { via?: string; file: string };
}

export interface DataSourceInfo {
  kind:
    | "api-call"
    | "prop"
    | "state"
    | "store"
    | "context"
    | "import"
    | "database"
    | "env"
    | "queue-publish"
    | "queue-consume";
  name: string;
  /**
   * For queue kinds: the broker destination — exchange (RabbitMQ publish),
   * queue (consume / sendToQueue), or topic (Kafka). May be a non-literal
   * expression's source text (`_eventConsumerConfiguration.Queue`) when the
   * name is resolved at runtime; still useful as a label and join key.
   */
  target: string | null;
  /**
   * The target is the value of this name, which the file does not define
   * (`kafka.Topic`, another package's variable; `TOPIC`, a constant another
   * file of the package declares). The project pass sets `target` to the
   * value the defining module states (`FileAnalysis.moduleValues`) when one
   * does; otherwise `target` stays as the plugin wrote it.
   */
  targetRef?: string;
  /**
   * An element's request whose URL sits in this markup attribute
   * (`data-update-url`): it stands only where a project script reads the
   * attribute (`FileAnalysis.attributeReads`), with the verb those scripts agree on.
   */
  urlAttribute?: string;
  calls: CallInfo[];
  line: number;
  /**
   * Resolved ORM entity/model/table this DB op touches, when derivable from
   * the call chain (e.g. "user" from `prisma.user.findMany`) or the DML target
   * (e.g. the table named in `knex("users")`). Only meaningful for
   * `kind === "database"`. Populated by `enrichFileDataSources`.
   *
   * For `queue-publish`: the routing key or message type when statically
   * visible (`GrantExpiringMessage.RoutingKey`, `new OrderCreatedEvent(...)` →
   * "OrderCreatedEvent") — the business-level name of the event.
   */
  entity?: string;
  /**
   * For `database`: the call is made on a variable holding one row
   * (`self.club1.save()`, `match.delete()`) whose model the plugin could not
   * tell, so the segment before the verb names no entity — `enrichFileDataSources`
   * leaves `entity` empty instead of reading the variable's name as a table.
   */
  receiverIsInstance?: boolean;
  /**
   * For `database`: a related manager queried (`club.players.all()`,
   * `self.tags.filter(…)`), named after the relation field it reads through.
   * The field names no table, so `enrichFileDataSources` leaves `entity`
   * empty; the plugin's project pass sets it to the model the field relates
   * to, when the project's models say which one.
   */
  relatedField?: string;
  /**
   * For `database`: the statement names the model an attribute of the
   * enclosing instance holds (`select(self.model)`, `session.query(self.model)`).
   * `entity` stays empty; the plugin's project pass sets it to the model every
   * construction of the class and its subclasses hands that attribute, when
   * they agree on one.
   */
  entityAttribute?: string;
  /**
   * For `database`: the table read is the enclosing class's type parameter of
   * this name (`_database.Query<TModel>(…)` inside `BasicRepository<TModel>`).
   * `entity` stays empty; the data-flow reach binds the parameter along each
   * call chain to the type a caller closes it over (`: BasicRepository<Club>`).
   */
  entityTypeParameter?: string;
  /**
   * For `queue-publish`/`queue-consume`: the channel is this parameter of the
   * enclosing function (`clientSend(event, room) { server.to(room).emit(event) }`);
   * `target` stays null. Core adds a row at each call site that hands the
   * function a literal there (`clientSend("match_update", room)`), through the
   * call's resolved link and its `CallInfo.args`.
   */
  channelParameter?: string;
  /**
   * For `queue-consume`: the function or method of this file that handles the
   * message (`Class.method`), when it is not the one the registration sits in —
   * `events.RegisterListener(name, &SendNotification{})` is consumed by
   * `SendNotification.Handle`. The access is attributed to it. For `database`:
   * a route of this file whose own access it is (`route:<METHOD> <path>`, the
   * anchor the symbol linker mints) — a route a framework serves per stored
   * resource, with no handler function; its `access` is then that route's own.
   */
  handler?: string;
  /**
   * For `queue-publish`: the message is the enclosing method's parameter at
   * this position (`emit(Entity e, Object event)` → 1), so the destination is
   * the type each caller hands it — a project pass adds a row at those calls.
   */
  payloadParameter?: number;
  /**
   * For `database`: the named query the call runs (`em.createNamedQuery("match.byClub")`),
   * declared elsewhere — a project pass fills `entity` from the query's declaration.
   */
  namedQuery?: string;
  /**
   * For `database`: `target` is a stored procedure or table-valued function the
   * statement calls (`EXECUTE PROCEDURE X`, `SELECT … FROM SP_X(:a)`), not a
   * table. It names no ER entity; the trace shows the routine by name.
   */
  routine?: true;
  /**
   * For `database`: `target` is a store with no tables — a key-value store or
   * cache (`Redis: StringSetAsync`). It names no ER entity; the trace reaches
   * the store by name.
   */
  store?: true;
  /**
   * For `database`: a further source the same statement reads beside its own
   * (a JOINed table, a subquery's table) — the row before it on the same line
   * is the statement's own target. Consumers asking which table a query is
   * ABOUT skip these.
   */
  joined?: true;
  /**
   * For `api-call`: the named environment variable of a leading base that was
   * stripped to keep `target` app-relative (e.g. `VITE_API` from
   * `import.meta.env.VITE_API + "/api/x"`). Display/deployment-facing; `target`
   * stays app-relative so the route join is unaffected. Populated by the
   * symbolic value resolver.
   */
  baseEnv?: string;
  /**
   * For `api-call`: the named endpoint the call is declared as or invokes (RTK
   * Query `getPosts`). A call through a generated hook states only the name;
   * the project pass fills its method and URL from the endpoint's definition.
   */
  endpoint?: string;
  /**
   * For `api-call`: the client INSTANCE the request goes through, when it is
   * a plain variable (`apiClient` in `apiClient.get("/users")`). A project
   * pass prepends that client's base URL (`FileAnalysis.httpClientBases`, in
   * this file or the one it is imported from) before the route join.
   */
  client?: string;
  /**
   * For `api-call`: the other URLs this call may resolve to, when it goes
   * through a URL-builder helper whose body returns a different URL per branch
   * (see `FunctionInfo.urlTemplateAlternatives`). `target` is the first branch;
   * the route join tries these in order when `target` matches no route.
   */
  /**
   * The subclass this row's URL was resolved for, when a base-class method's
   * call (`this.requests.patch(this.itemRoute(id))` in a generic CRUD client)
   * was fanned out per concrete subclass. Such a row is what the client CAN
   * request; one that reaches no route is not reported as a miss — the method
   * is inherited, not necessarily called.
   */
  viaSubclass?: string;
  targetAlternatives?: string[];
  /**
   * For `kind === "database"`: whether the op reads or writes, when the plugin's
   * ORM knowledge can tell (e.g. `findMany` → read, `create`/`save` → write).
   * Absent = unclassified (the dataflow-lite pass keeps such an access as the
   * coarse `db` effect rather than guessing). The write-verb knowledge stays in
   * the language plugins — core never inspects method names.
   */
  access?: "read" | "write";
  /**
   * Provenance of a resolved `target`: EXTRACTED (fully literal), INFERRED (the
   * fold left `{param}`/`{}`/`{env}` holes), or AMBIGUOUS (a conflicting
   * binding). Absent when `target` was a plain literal needing no resolution.
   */
  targetConfidence?: Confidence;
  /**
   * For `api-call`: the body the call sends, as far as the call site states it
   * — an object literal or a local constant holding one (`axios.post(url,
   * { name, email })`, `fetch(url, { body: JSON.stringify(dto) })`). Property
   * types come from literal values; a value the extractor cannot type is an
   * empty schema. `additionalProperties: true` when a spread may add more.
   */
  requestBody?: JsonSchemaNode;
  /**
   * For `api-call`: where the values of the URL's `{name}` placeholders come
   * from when the request is built from a parameter of the enclosing function
   * — that argument's `field` object (a generated SDK's
   * `getClub = (options) => client.get({ url: '/clubs/{id}', ...options })`
   * takes `id` from `options.path.id`: `{ index: 0, field: "path" }`).
   */
  pathValues?: { index: number; field: string };
  /**
   * For `api-call`: the top-level fields the caller reads off the response
   * body (`const { items } = await res.json()`, `res.data.total`), sorted.
   * Absent when the response is not read or flows somewhere the extractor
   * cannot follow.
   */
  responseReads?: string[];
  /**
   * For an api-call: the URL's leading base was a runtime value no pass could
   * resolve (`this.baseUrl`, `environment.apiBaseUrl`, a client's base), so it
   * was split off and `target` holds the app-relative rest (`/series/{}`). The
   * base may span any number of segments, so the linker matches such a call
   * only literally, through a known base prefix, or as a unique suffix — never
   * by letting the base stand for one wildcard segment. Set on the project's
   * aggregated rows, not per file.
   */
  baseExpr?: string;
  /** For an api-call made through a request factory: the factory, its URL filled in from this call site's arguments. */
  via?: string;
  /** For an api-call made through a client proxy: the interface operation it invokes. */
  contract?: ApiContract;
  /**
   * For an api-call: where its base URL comes from, as the source states it —
   * the registered client it is made through (`_http` of a typed client,
   * `CreateClient("legacy")`), or an environment variable / configuration key.
   * A plugin fact; what the reference resolves to is decided by core (`origin`).
   */
  baseRef?: CallBaseRef;
  /**
   * For an api-call: the service it reaches, resolved from the base reference
   * through configuration, deployment env and the service address book. Set on
   * the project's aggregated rows. Absent when nothing states where it goes.
   */
  origin?: CallOrigin;
  /**
   * The team declared this call a data access (`.clarifydoc/config.json`
   * `extract`): kept even where the call resolves into the project's own
   * code, which otherwise reads as a call, not an access.
   */
  declared?: true;
}

/** Where a call's base URL comes from, as the source states it. */
export interface CallBaseRef {
  /**
   * `env`: an environment variable · `config`: a configuration key ·
   * `client`: the base a registered client carries · `literal`: written out ·
   * `service`: a name service discovery resolves (Spring `@FeignClient(name = "orders")`,
   * `lb://orders`), which reaches only a project registered under it.
   */
  kind: "env" | "config" | "client" | "literal" | "service";
  /**
   * `ORDERS_URL` · `Services:Orders` · a client as its registration names it
   * (`InventoryClient`, `name:legacy`) · `http://orders:8080`.
   */
  key: string;
  /** A literal the code falls back to when the variable or key is unset (`?? "http://localhost:5002"`). */
  fallback?: string;
}

/**
 * An HTTP client configured with a base URL: `AddHttpClient<T>(c =>
 * c.BaseAddress = …)`, `axios.create({ baseURL: … })`. A call made through
 * the client inherits the base.
 */
export interface HttpClientRegistration {
  /**
   * What a call names to use it: a variable, a type, or `name:<n>` for a named
   * client. A client proxy is keyed by the fully qualified interface it proxies.
   */
  client: string;
  /**
   * `file`: a variable, visible in this file and to the files importing it.
   * `project`: a type or a client name, visible across the sub-project.
   */
  scope: "file" | "project";
  /** Where the client's base comes from; absent when the registration does not say. */
  base?: CallBaseRef;
  /**
   * The client is a generated proxy of this API interface (fully qualified):
   * a JAX-RS / CXF / RESTEasy proxy, a Feign or MicroProfile client. Every call
   * on a receiver of that type is an HTTP request to the operation the
   * interface method declares.
   */
  proxyOf?: string;
  line: number;
}

/**
 * An API operation named by the interface method that declares it — the
 * shared contract a client proxy calls and a resource implements
 * (`com.acme.person.api.PersonRepository#getPerson`). Joins a call to its
 * route without either side knowing a URL.
 */
export interface ApiContract {
  /** Fully qualified type declaring the operation (the shared API interface). */
  type: string;
  method: string;
}

/**
 * A rule that forwards requests: a dev server's proxy (Vite, webpack, Angular,
 * CRA) or a gateway route (YARP, Ocelot). Requests arriving at the project
 * that declares it whose path starts with `pathPrefix` go on to `target`,
 * the prefix replaced by `rewriteTo` when set.
 */
export interface ProxyRule {
  /** `/api`, `/api/orders`; "" forwards every path. */
  pathPrefix: string;
  /** Where to: an address (`http://localhost:5000`, `http://orders:8080`). */
  target: string;
  /** What replaces `pathPrefix` before forwarding (`/api` → ""); absent = the path is kept. */
  rewriteTo?: string;
  /** What declared it: `vite`, `webpack`, `angular`, `cra`, `yarp`, `ocelot`. */
  via: string;
  /** Project-relative posix path of the declaring file. */
  file: string;
  line?: number;
}

/** Where an outbound call goes, resolved from the facts that state it. */
export interface CallOrigin {
  /** The reference the base came from, after following a client to its registration. */
  baseRef?: CallBaseRef;
  /** Host the call goes to (`orders`, `api.stripe.com`, `localhost:5102`). */
  host?: string;
  /** Sub-project serving that host. Absent when no project answers to it, or several do. */
  project?: string;
  /** The host is not one of this analysis's services. */
  external?: boolean;
  /** The third-party service an external host belongs to (`Stripe` for `api.stripe.com`), when it is a known one. */
  service?: string;
  /**
   * The environment variables that would set the base (an `env` reference's
   * own name, or what overrides a `config` key) — kept when nothing in this
   * analysis states their value, so a deployment elsewhere (an infra
   * repository's compose file) still can.
   */
  envNames?: string[];
  /**
   * The path the request takes at `host`, when a forwarding rule rewrote it
   * on the way to a host this analysis has no project for. The call's own
   * `target` is left as written.
   */
  path?: string;
  /**
   * EXTRACTED — every value stated for the base names one project.
   * INFERRED  — only a code fallback did, or the values disagreed only with
   *             hosts outside the analysis.
   * AMBIGUOUS — the values name different projects; none is chosen.
   */
  confidence: Confidence;
  /** Each fact that led there, in order: client registration, env/config value, address. */
  evidence: Array<{ step: "client" | "env" | "config" | "literal" | "fallback" | "address" | "proxy" | "service"; detail: string; file?: string; line?: number }>;
}

/**
 * A name a sub-project answers to at runtime: a compose service or a k8s
 * Service DNS name, a host port compose maps onto it, or a URL it listens on
 * (launchSettings `applicationUrl`). Calls resolve their host through these.
 */
export interface ServiceAddress {
  /** Lowercased host (`orders`, `localhost`). */
  host: string;
  port?: number;
  project: string;
  /**
   * `service`: a compose service / k8s workload name · `alias`: another DNS
   * name it answers to (k8s Service, `hostname`, network alias) · `port`: a
   * host port compose publishes onto it · `listen`: a URL its own
   * configuration binds (launchSettings `applicationUrl`, Kestrel `Urls`) ·
   * `name`: the name its configuration registers it under in service discovery
   * (Spring `spring.application.name`).
   */
  source: "service" | "alias" | "port" | "listen" | "name";
  /** The manifest or config file stating it. */
  file: string;
}

/**
 * A relation between two ORM entities, richer than `ClassInfo.implements`
 * (which only records the related name). Emitted per file alongside the
 * entity `ClassInfo`s a file defines, by the language `entities` extractor.
 */
export interface EntityRelation {
  /** Entity declaring the relation — matches a ClassInfo.name in this file. */
  fromEntity: string;
  /** Field/property on fromEntity holding the relation (e.g. "author", "posts"). */
  fromField: string;
  /** Target entity name — matches a ClassInfo.name somewhere in the project. */
  toEntity: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  /** Owning-side foreign-key column, when the ORM declares it (e.g. "authorId"). */
  foreignKey?: string | null;
  /** Inverse field on toEntity, when the ORM declares both sides. */
  inverseField?: string | null;
  /** Join/through/pivot table for many-to-many relations, when named. */
  joinTable?: string | null;
  /** Whether the relation is optional (nullable FK). */
  optional?: boolean;
  /** Originating ORM, e.g. "prisma" | "typeorm" | "gorm". */
  orm?: string;
  /** EXTRACTED for explicit schema/decorators, INFERRED for name heuristics. */
  confidence?: Confidence;
}

/**
 * One `create_table` block parsed from a Rails `db/schema.rb` (the consolidated
 * schema dump). ActiveRecord/Sequel models declare no columns in the model
 * class — they live in the schema — so this carries the column list that a
 * project-level join (`applyRailsSchemaColumns`) attaches to the matching model
 * entity by table-name convention. Emitted on the schema file's FileAnalysis.
 */
export interface RailsSchemaTable {
  /** Physical table name as written in `create_table "..."` (e.g. "absences"). */
  table: string;
  /** Columns in declaration order; the implicit `id` primary key is prepended. */
  columns: PropertyInfo[];
}

/**
 * A detected ORM/DB migration file or directory, surfaced at the project level
 * so the report can show schema evolution chronologically.
 */
export interface MigrationInfo {
  /** Migration file (or migration-dir's representative file), relative path. */
  filePath: string;
  ecosystem:
    | "prisma"
    | "typeorm"
    | "sequelize"
    | "rails"
    | "django"
    | "ef-core"
    | "gorm"
    | "diesel"
    | "doctrine"
    | "flyway"
    | "liquibase"
    | "alembic";
  /** Migration name/identifier parsed from the path (timestamp + slug, version). */
  name: string;
  /** Sort key — timestamp or numeric version when parseable, else the name. */
  order: string;
}

export interface DataMutationInfo {
  kind: "setState" | "dispatch" | "assignment" | "ref-mutation" | "db-write";
  target: string;
  value: string | null;
  line: number;
}

export interface SubComponentInfo {
  name: string;
  importSource: string | null;
  props: string[];
  line: number;
  /**
   * Registered app-wide by this file rather than used in it — Vue's
   * `app.component("ClubCard", ClubCard)`: a tag no file imports is that
   * import source's component, wherever it is used.
   */
  global?: true;
}

/** One app-wide instance member a file installs (`FileAnalysis.globalMembers`). */
export interface GlobalMemberDef {
  /** The member as components read it: `$session`. */
  name: string;
  /** The identifier the file assigns to it — an import or a module-level binding of the file. */
  binding: string;
  line: number;
}

/**
 * A custom-element (Web Component) registration in a JS/TS file:
 * `customElements.define("user-card", UserCard)` or Lit
 * `@customElement("user-card") class UserCard`. Web components are used in
 * markup by their kebab-case TAG (`<user-card>`), not by an imported symbol, so
 * the component graph joins a `<user-card>` usage to its defining file through
 * these registrations (a tag→file index) rather than an import path.
 */
export interface CustomElementDef {
  /** The registered kebab-case tag (`user-card`). */
  tag: string;
  /** The implementing class/constructor name (`UserCard`). */
  className: string;
  line: number;
}

/** A component usage from a frontend template, flat & de-duped. */
export interface TemplateComponent {
  name: string;
  props: string[];
  line: number;
}

/**
 * Framework-neutral nested component tree node. Produced per-frontend (Vue SFC
 * template, React JSX AST, Svelte/Angular templates) and consumed uniformly by
 * `treeToComponents` to build the screen's `ScreenComponentInfo` tree.
 */
export interface TemplateComponentNode extends TemplateComponent {
  /** True when this node is rendered in a loop — it carries the framework's
   *  loop construct (Vue `v-for`, Angular `*ngFor`, Svelte `{#each}`,
   *  React `.map()`), or an enclosing element/scope does. */
  repeated: boolean;
  /** For an interactive HTML element promoted into the tree (`<button>` with a
   *  handler, bound `<input>`, …) — its element kind. Undefined for components. */
  element?: "button" | "input" | "form" | "link" | "select" | "textarea";
  /** Child nodes (components or interactive elements) nested under this one. */
  children: TemplateComponentNode[];
}

export interface InteractiveElementInfo {
  element: "button" | "input" | "form" | "link" | "select" | "textarea" | "custom";
  event: string;
  handler: string | null;
  line: number;
  /**
   * For `element === "custom"`: the component tag the binding sits on
   * (`<MyButton @click=…>` → "MyButton"). Joined against the file's
   * subComponents to wire a child's `emit('save')` to THIS parent handler —
   * without the tag, two children used in one template are indistinguishable.
   */
  component?: string;
  /**
   * The HTTP request the element sends when used — a server-rendered form, a
   * `button_to`, a link: `method` and `target`, the target a literal app path
   * (`/users/42/edit`) or the framework's route helper (`edit_user_path`) that a
   * plugin resolver maps to a route. Absent for elements that run client code.
   * `attribute`: the URL sits in a markup attribute a page script reads and
   * requests (`data-url="{% url 'clubs:detail' %}"`); `method` is then the
   * element's own `data-method`, or "" until the scripts reading it agree on
   * one (`core/attribute-requests.ts`).
   */
  request?: { method: string; target: string; attribute?: string };
  /** The text a person reads on it: a link's or button's label, a submit input's `value` ("Place Order"). */
  caption?: string;
  /**
   * A markup element with no handler of its own, as a compound selector of what
   * a script can find it by — `button#save.btn[data-delete]`: tag, id, classes
   * and attribute names. A page script's `domBindings` join on it.
   */
  selector?: string;
}

/** One listener a script binds by selector. `handler` is null for an inline function (its calls are the enclosing function's). */
export interface DomBinding {
  selector: string;
  event: string;
  handler: string | null;
  line: number;
}

export interface EventInfo {
  name: string;
  params: ParamInfo[];
  line: number;
}

// ─── Screen / Form types ─────────────────────────────────────────────────

export type ScreenComponentCategory =
  | "container"
  | "input"
  | "display"
  | "data"
  | "action"
  | "navigation"
  | "custom";

export interface ScreenComponentInfo {
  name: string;
  componentType: string;
  category: ScreenComponentCategory;
  caption: string | null;
  position: { left: number; top: number; width: number; height: number } | null;
  align: string | null;
  visible: boolean;
  children: ScreenComponentInfo[];
  events: string[];
  dataBindings: string[];
  /** True for a component rendered in a loop (Vue `v-for`, or an enclosing
   *  `v-for`). Drives the loop badge in the screen's component tree. */
  repeated?: boolean;
  line: number;
}

export interface ScreenInfo {
  name: string;
  formType: string;
  caption: string | null;
  dimensions: { width: number; height: number } | null;
  components: ScreenComponentInfo[];
  filePath: string;
  routePath: string | null;
  navigatesTo: string[];
  /**
   * How the application creates this screen at startup, when it does.
   *
   * A Delphi `.dpr` states this outright: the FIRST `Application.CreateForm`
   * is the main form — the window the user gets when the app launches, and the
   * root of the navigation graph — and any later ones are auto-created at
   * startup but shown on demand. Absent for every screen the app constructs
   * later on (the normal case).
   */
  startup?: "main" | "auto-created";
  /**
   * The type the view binds against, as written without its namespace prefix
   * (XAML `x:DataType="viewmodels:BasketViewModel"` → `BasketViewModel`): where
   * `{Binding CheckoutCommand}` and the other bindings of the view resolve.
   */
  viewModel?: string;
  /**
   * The server routes whose handlers render this template by name
   * (`render_template("league/table.html")`, `return "garage/list"`): the page
   * each of them serves, and the data it shows is what they load. Set by core's
   * rendered-view pass (`core/rendered-views.ts`).
   */
  renderedBy?: Array<{ filePath: string; method: string | null; path: string; line: number }>;
  /**
   * Files whose code is the screen's own, beside its page file: a Delphi
   * form's `.pas` unit, where `class procedure Execute` builds and loads it.
   * The screen reaches what their functions reach, as it does its own.
   */
  codeFiles?: string[];
}

/**
 * A "this file opens that component" relationship, derived from a dynamic
 * `import("./X.vue")`. Captured directly (a function in `sourceFile` imports the
 * component) or transitively through a launcher function — e.g. a screen calls
 * a dialog barrel's `DutyDialog()`, which itself `import()`s the dialog SFC.
 * Powers the Screens & UI pane's "opens" / "opened by" cross-links for dialogs
 * and other lazily-mounted components that never appear as template tags.
 */
export interface ComponentLaunch {
  /** File that opens the component (a page/screen, or the launcher's own file). */
  sourceFile: string;
  /** Symbol in `sourceFile` that triggers the open (the calling function, or
   *  the launcher function itself for a direct import). */
  sourceSymbol: string;
  /** The component file being opened (e.g. a dialog SFC). */
  targetFile: string;
  /** Launcher function the open routes through (e.g. "DutyDialog"); equals
   *  `sourceSymbol` for a direct dynamic import in `sourceFile`. */
  launcher: string;
  /** Line of the call/import in `sourceFile`. */
  line: number;
}

export type LinkProximity = 1 | 2 | 3;

export interface LinkInfo {
  source: string;
  target: string;
  proximity: LinkProximity;
  reason: string;
  calls: string[];
  confidence?: Confidence;
}

/**
 * Which resolution strategy produced a `SymbolLink`.
 *
 * `confidence` says how much to trust an edge; this says *why* it exists. The
 * two are not the same question: an `INFERRED` link from inheritance lookup and
 * an `INFERRED` link from a globally-unique-name guess warrant very different
 * scepticism, and without this tag `lsp:compare` cannot attribute a conflict to
 * the strategy that caused it — which is what `AGENTS.md`'s standing rule
 * "reject any strategy that introduces conflicts" requires to be enforceable.
 *
 * Names are short because they are rendered to users (`[inferred via
 * unique-global]`). Grouped below in the order the linker attempts them.
 */
export type SymbolLinkStrategy =
  // ── Call cascade (symbol-linker.ts `resolveCallToDefinition`) ──
  /**
   * Exact name (or leaf) found in the target file — no heuristic applied.
   * Where the language's scope is the directory (`directoryScope`, a Go
   * package), the target file is the one in it that declares the name; where
   * the imported file only re-exports it (a barrel, a package `__init__`),
   * the file the re-export leads to.
   */
  | "direct"
  /** Walked the extends-chain to a parent's member. */
  | "inheritance"
  /** Receiver's declared type is an interface; linked past it to the implementation. */
  | "interface-redirect"
  /** Receiver type came from a field, constructor/method param, or typed local. */
  | "injection"
  /**
   * Receiver's declared type (or DI token) is bound by a container
   * registration (`FileAnalysis.diBindings`) to one implementation; linked to
   * that implementation's member.
   */
  | "di-binding"
  /** Cross-file qualified call matched by dotted suffix (`prisma.user.findMany`). */
  | "deep-qualified"
  /** Member absent from the target module; routed to the factory in `CallInfo.via`. */
  | "factory-via"
  /** `ClassName.method` resolved through the class-name index. */
  | "class-name"
  /** `new X` / bare class instantiation. */
  | "constructor"
  /** Head of the call is an import alias resolving to one file. */
  | "import-file"
  /** Head of the call is an import naming a directory; unique-or-nothing tail match. */
  | "import-dir"
  /** Unique leaf name project-wide, backed by evidence (same dir, or actually imported). */
  | "unique-global"
  /**
   * Unique leaf name project-wide with NO import evidence either way — the
   * import-blind-ecosystem fallback (CodeIgniter-style autoloading). Strictly
   * weaker than `unique-global`; kept separate precisely so it can be measured
   * and, if it earns its keep poorly, dropped on its own.
   */
  | "unique-global-blind"
  /** Linked to a generic type argument's class (`_context.Set<Account>()`). */
  | "type-argument"
  // ── Outer pipeline (symbol-linker.ts `buildSymbolLinks`) ──
  /** Frontend route → the component file its handler names. */
  | "route-component"
  /** Route file IS the page component; anchored at its own setup block. */
  | "route-self"
  /** Last-resort global scan for a route handler name. */
  | "route-scan"
  /** Spec route (OpenAPI/WSDL/GraphQL) joined to an implementation by name. */
  | "spec-join"
  /**
   * A route its `owner` class serves through an inherited action: linked to the
   * owner's override of a method that action calls on itself.
   */
  | "route-override"
  /** Interface → each implementation, for navigation only. */
  | "interface-fanout"
  /** Reverse edge from an import specifier back to the symbol it names. */
  | "reference"
  // ── Produced outside the linker ──
  /** Frontend api-call matched to the backend route serving it. */
  | "api-route"
  /** Message-queue publish matched to its consumer. */
  | "queue"
  /** Language server `textDocument/definition`. */
  | "lsp-definition"
  /** Language server `textDocument/references`. */
  | "lsp-reference"
  /** A plugin dispatch resolver, identified by its `id` (`dispatch:mediatr`). */
  | `dispatch:${string}`;

/**
 * What KIND of edge this is, as opposed to how it was found.
 *
 * Consumers used to sniff strings for this (`sourceSymbol === "(reference)"`),
 * which is both fragile and silent when it drifts.
 */
export type SymbolLinkRelation =
  /** A call from one symbol to another. The default. */
  | "calls"
  /** Construction of a type (`new X`). */
  | "instantiates"
  /** Interface → implementation, either direction. */
  | "implements"
  /** Crosses the HTTP boundary: a client call to the route that serves it. */
  | "http"
  /** Crosses a message queue: publish → consume. */
  | "mq"
  /** Resolved through a framework's indirection rather than a direct call. */
  | "dispatch"
  /** A reverse edge from an import back to the symbol it names, not a call. */
  | "reference";

export interface SymbolLink {
  sourceFile: string;
  sourceSymbol: string;
  sourceLine: number;
  callName: string;
  targetFile: string;
  targetSymbol: string;
  targetLine: number;
  resolvedBy?: "text" | "lsp";
  confidence?: Confidence;
  /**
   * The strategy that produced this link, as it FINALLY stands.
   *
   * Two things follow from "finally". `dedupSymbolLinks` keeps the
   * highest-confidence duplicate, so when several strategies find the same edge
   * this records the one that won, not every one that agreed. And a link that
   * is later re-aimed (LSP's interface redirect) is re-tagged at that point
   * rather than keeping the tag of whatever first created it.
   */
  strategy?: SymbolLinkStrategy;
  /** What kind of edge this is (call, instantiation, HTTP hop, …). */
  relation?: SymbolLinkRelation;
  /**
   * True for *navigational* edges that aid the trace view but are NOT real
   * dependencies — specifically interface→implementation fan-out (an interface
   * does not depend on its implementors). Excluded from the component dependency
   * graph so they don't fabricate cycles across every sibling that shares an
   * interface. In-memory only (not persisted in the normalized summary).
   */
  navigational?: boolean;
  /**
   * The receiver's declared class (and its file) when the method called is
   * inherited from another class — `api.mealplans.createOne()` on a
   * `MealPlanAPI` lands on `BaseCRUDAPI.createOne`. The HTTP-edge pass moves
   * such a link onto the subclass's own member when the base method's request
   * was resolved per subclass. In-memory only: dropped once that pass ran.
   */
  viaType?: string;
  viaTypeFile?: string;
  /**
   * When the target is a method of a generic class: what the caller closes the
   * class's type parameters over, in order (`_clubs.All()` on an
   * `IRepository<Club>` reaching `Repository<TModel>.All` → `["Club"]`; null
   * where unbound). An argument may be one of the caller's own type parameters.
   * Read by the data-flow reach to name the table a generic repository touches.
   * In-memory only: dropped once the reach ran.
   */
  typeArgs?: Array<string | null>;
}

/**
 * Default `relation` for a strategy. Every producer knows its strategy, and for
 * all but a handful the relation follows from it — so deriving here keeps the
 * two fields consistent by construction instead of asking twenty call sites to
 * remember both.
 */
export function relationForStrategy(strategy: SymbolLinkStrategy): SymbolLinkRelation {
  if (strategy.startsWith("dispatch:")) return "dispatch";
  switch (strategy) {
    case "constructor":
      return "instantiates";
    // Only the fan-out edge asserts the implements relationship. A redirect is
    // an ordinary call that merely had to go through the interface to find its
    // target — labelling it "implements" would tell a consumer the caller
    // implements something, which it does not.
    case "interface-fanout":
      return "implements";
    case "api-route":
      return "http";
    case "queue":
      return "mq";
    case "reference":
    case "lsp-reference":
      return "reference";
    default:
      return "calls";
  }
}

/**
 * A database access attributed to the function/method that contains it — the
 * bridge between the symbol-level Call Traces graph and the entity-level Data
 * Model. One entry per (file, symbol, entity); `sites` lists the DB call lines.
 * Built by `attributeDataAccessToSymbols` in data-access-graph.ts.
 */
export interface SymbolDataAccess {
  /** Defining file of the containing function. */
  file: string;
  /** Containing symbol — "Class.method" | "functionName" (matches SymbolLink.sourceSymbol). */
  symbol: string;
  /** Containing function's start line. */
  symbolLine: number;
  /** Entity touched: the ER-diagram node name when matched, else the raw call segment. */
  entity: string;
  /** True when `entity` resolves to an EntityGraphNode name (drives the reverse ER view). */
  entityMatched: boolean;
  /** Datastore target, e.g. "@prisma/client" (null when unresolved). */
  datastore: string | null;
  /**
   * How the symbol touches the resource. Absent = "database" (the historical
   * meaning). Queue kinds mark message-broker I/O: `entity` is the routing
   * key / message type / topic and `datastore` the exchange/queue — the
   * "event on RabbitMQ" endpoint of a button→…→event trace.
   */
  access?: "queue-publish" | "queue-consume";
  /** Individual DB call sites inside the function, sorted by line. */
  /** `access`: set where one line holds several routes' own accesses (`DataSourceInfo.handler` naming a route). */
  sites: Array<{ name: string; line: number; access?: "read" | "write" }>;
}

/**
 * A data-access effect kind for the transitive propagation pass. `db` is the
 * coarse historical bucket (the engine records `DataSourceInfo.kind === "database"`
 * without a read/write flag); `db-read`/`db-write` are reserved for a later
 * refinement (a plugin-provided classifier / DataMutationInfo join) and are not
 * populated yet.
 */
export type DataEffectKind =
  | "db"
  | "db-read"
  | "db-write"
  | "queue-publish"
  | "queue-consume"
  | "api-call";

/** One data-access effect reached (directly or transitively) from a symbol. */
export interface ReachedEffect {
  kind: DataEffectKind;
  /** Entity/table, broker destination, or api target the effect touches. */
  resource: string;
  /** File where the effect is DIRECTLY performed. */
  originFile: string;
  /** Symbol ("Class.method" | "fn") where the effect is directly performed. */
  originSymbol: string;
  /** 0 = direct; ≥1 = transitive (call-graph hops to the nearest origin). */
  distance: number;
  /** EXTRACTED at distance 0; INFERRED transitively; AMBIGUOUS if a heuristic link is on the path. */
  confidence: Confidence;
}

/**
 * Per-symbol "dataflow-lite" summary: the set of data-access effects a
 * function reaches through the call graph, computed by transitive propagation
 * (data-flow-reach.ts). Emitted only for symbols that reach at least one effect.
 */
export interface SymbolReachSummary {
  /** Defining file of the symbol (matches SymbolLink.sourceFile). */
  file: string;
  /** Symbol name ("Class.method" | "fn", matches SymbolLink.sourceSymbol). */
  symbol: string;
  /** Reached effects (capped; true totals in `effectCounts`), most-direct first. */
  effects: ReachedEffect[];
  /** Count of reached effects per kind (exact even when `effects` is capped). */
  effectCounts: Partial<Record<DataEffectKind, number>>;
  /** True when at least one effect is reached transitively (distance ≥ 1). */
  hasTransitive: boolean;
}

/**
 * A source→sink row: a UI/route entry point that transitively reaches a data
 * effect. The natural payoff of the reach pass — e.g. filter on
 * `effect === "db-write"` for "which handlers reach a DB write". Grounded in the
 * existing call graph, not a taint engine.
 */
export interface DataFlowPath {
  entryKind: "route" | "screen" | "command";
  /** "POST /api/orders" for a route, or the screen name. */
  entryLabel: string;
  entryFile: string;
  effect: DataEffectKind;
  resource: string;
  distance: number;
  confidence: Confidence;
  /**
   * The witness: the call path from the entry to the function that performs
   * the effect, entry first, at most `distance + 1` hops. Each hop but the last
   * carries `line`, the call in it that leads to the next. Absent on artifacts
   * written before it was recorded.
   */
  via?: FlowHop[];
  /** How much this flow matters when something goes wrong (flow-criticality.ts). Absent on older artifacts. */
  criticality?: FlowCriticality;
}

/** A data flow's criticality: a 0–100 score, its level and the reason ids behind it. */
export interface FlowCriticality {
  score: number;
  level: "critical" | "high" | "medium" | "low";
  /** Reason ids (`FLOW_REASON_LABELS`): the effect first, then each signal that added to the score. */
  reasons: string[];
  /** Entry points that reach the same effect on the same resource, when more than one. */
  sharedBy?: number;
}

/** One function on a data flow's witness path (`DataFlowPath.via`). */
export interface FlowHop {
  file: string;
  symbol: string;
  /** The line in this function of the call that leads to the next hop. */
  line?: number;
}

export interface LspStats {
  /** Where the answers came from: `docker` (our language-server images) or `editor` (the editor's own). Absent = docker. */
  source?: string;
  serversUsed: string[];
  lspResolvedCount: number;
  referenceLinksCount: number;
  enhancementTimeMs: number;
  /** When the enhancement was produced. Absent on deltas written before this was recorded. */
  enhancedAt?: string;
  /**
   * The delta predates the analysis it was found next to, so its graphs describe
   * source that has since been re-analyzed and were NOT merged. Run `lsp-update`
   * to refresh it.
   */
  stale?: boolean;
  /** Of a stale delta, the links carried over because the files they join have not changed since. */
  carried?: number;
}

/**
 * One textDocument/definition query and its raw answer, recorded so the
 * text-based linker can be measured against what LSP resolved.
 * `target: null` means LSP was queried but returned no definition —
 * the text linker shouldn't be expected to resolve those either.
 */
export interface LspDefinitionRecord {
  sourceFile: string;
  sourceSymbol: string;
  line: number;
  column: number;
  callName: string;
  callKind: string;
  language: Language;
  /** Raw LSP answer (file + 1-based line), before interface redirection. */
  target: { file: string; line: number } | null;
  /** Where the link was re-aimed when interface→implementation redirection changed the target. */
  redirectedTarget?: { file: string; symbol: string; line: number };
}

/**
 * One textDocument/implementation query, at a call the dependency-injection
 * resolver left on an interface because it would not choose among its
 * implementations: what the language server says implements it. Ground truth
 * for the resolver, recorded, never applied.
 */
export interface LspImplementationRecord {
  sourceFile: string;
  sourceSymbol: string;
  line: number;
  column: number;
  callName: string;
  language: Language;
  /** The interface member the call stayed on (`INotifier.Send`). */
  interfaceSymbol: string;
  implementations: { file: string; line: number }[];
}

/** One textDocument/references query: the exported symbol and every non-self reference LSP found. */
export interface LspReferenceRecord {
  symbolFile: string;
  symbolName: string;
  symbolLine: number;
  language: Language;
  references: { file: string; line: number }[];
}

// ─── Advanced analysis types ────────────────────────────────────────────

export interface ComplexityInfo {
  functionName: string;
  /** Cyclomatic complexity: 1 + branches + logical operators. */
  complexity: number;
  line: number;
  endLine: number;
  /**
   * Cognitive complexity (an approximation of SonarSource's metric): every
   * branch adds 1 plus its nesting depth, `else`/`elif` continuations add 1
   * without a depth penalty, logical operators add 1. Separates "many flat
   * cases" from "deeply nested logic", which the cyclomatic number cannot.
   * Absent on rows written by extractor versions before 1.49.
   */
  cognitive?: number;
  /** Deepest branch nesting in the body — 0 for a branch-free body, 1 for a
   *  single `if`, 2 for an `if` inside a loop. Absent before 1.49. */
  nestingDepth?: number;
  /** Declared parameter count. Absent before 1.49. */
  paramCount?: number;
  /**
   * Counted from the function's text (branch keywords and operators, no
   * tree): a floor, not an exact structure walk — as the regex-path control-
   * flow graph is marked. Absent on rows measured from a parse tree.
   */
  approximate?: true;
}

export interface FileComplexityInfo {
  filePath: string;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
  /** Sum / max of the per-function cognitive complexity. Absent before 1.49. */
  totalCognitive?: number;
  maxCognitive?: number;
  /** Deepest nesting across the file's functions. Absent before 1.49. */
  maxNestingDepth?: number;
  functions: ComplexityInfo[];
}

/** Per-file git activity inside the history window (git-history.ts). */
export interface FileChurnInfo {
  /** Project-relative path, matching files[]. */
  file: string;
  /** Commits touching the file inside the window. */
  commits: number;
  additions: number;
  deletions: number;
  /** ISO timestamp of the most recent commit touching the file. */
  lastTouched: string;
  /** Top contributors by commit count (max 3), mailmap-aware names. */
  authors: string[];
  authorCount: number;
  /** The top contributors' commit counts (max 5), most first — `authors` with their weight. */
  authorShares?: Array<{ name: string; commits: number }>;
  /**
   * How many authors together made more than half of the file's commits: 1
   * means one person holds most of what is known about it.
   */
  busFactor?: number;
  /** Commits touching it that fixed something (a `fix:` commit, a revert, "fixes #12"), and the newest one's date. */
  fixes?: number;
  lastFix?: string;
  /**
   * The same fixes weighed by age — each counts half as much per 180 days
   * before the newest commit in the window — so a file fixed often long ago
   * is not flagged like one fixed often lately. Absent with no fixes.
   */
  fixScore?: number;
}

/**
 * Two files that change together in history — committed together in at least
 * three small commits, in at least 30% of the commits of the less-changed one.
 * Commits touching more than 20 analyzed files (merges of branches, mass
 * renames, formatting) are not counted.
 */
export interface CoChangePair {
  a: string;
  b: string;
  /** Commits touching both. */
  count: number;
  /** count ÷ commits of the less-changed file, (0..1], 2 decimals. */
  score: number;
  /** No import edge joins the two, in either direction: coupling the code does not show. */
  hidden?: boolean;
}

/** Churn × complexity hotspot — where the codebase actually hurts. */
export interface HotspotInfo {
  file: string;
  /** normalizedCommits × normalizedTotalComplexity, (0..1], 3 decimals. */
  score: number;
  commits: number;
  totalComplexity: number;
}

// ─── Responsibility profile (responsibility-profile.ts) ────────────────────

/** An external boundary a file touches, derived from imports, data sources, routes and screens. */
export type BoundaryKind =
  | "database" | "http" | "graphql" | "grpc" | "queue" | "auth" | "logging"
  | "cloud" | "serialization" | "validation" | "ui" | "state" | "config"
  | "cache" | "filesystem" | "email";

/** The workflow concern a boundary evidences. */
export type WorkflowRole =
  | "persistence" | "transport" | "messaging" | "security" | "observability"
  | "integration" | "mapping" | "validation" | "presentation" | "configuration"
  | "caching";

export interface BoundaryEvidence {
  kind: BoundaryKind;
  /** Where the evidence came from. */
  source: "import" | "data-source" | "data-mutation" | "route" | "screen";
  /** Import specifier, call name, route or screen name. */
  name: string;
  /** 1-based; absent for evidence without a location (screens). */
  line?: number;
  /** What the file does at that boundary — `use` when only the import is visible. */
  operation?: "read" | "write" | "use" | "call" | "serve" | "publish" | "consume" | "route" | "render";
}

/**
 * Which concerns one file mixes. Present only for files with at least one
 * boundary. `concernCount` is the number of distinct roles minus the
 * ubiquitous ones (observability, configuration) — the responsibility-spread
 * signal the god-object function count cannot give.
 */
export interface ResponsibilityProfile {
  filePath: string;
  boundaries: BoundaryKind[];
  roles: WorkflowRole[];
  concernCount: number;
  /** Distinct non-relative import roots — library fan-out. */
  externalPackageCount: number;
  readsState: boolean;
  writesState: boolean;
  emitsEvents: boolean;
  consumesEvents: boolean;
  /** Declares at least one API route. */
  servesRequests: boolean;
  /** Calls HTTP/GraphQL/gRPC/cloud services. */
  callsExternal: boolean;
  /** Total evidence rows found; `evidence` is capped. */
  evidenceCount: number;
  evidence: BoundaryEvidence[];

  /**
   * How the concerns are DISTRIBUTED inside the file. A 900-line module where
   * one function touches the queue and the rest do not is a very different
   * refactoring job from one where every function mixes database, HTTP and
   * queue, and the file-level count cannot tell them apart. Absent when no
   * boundary evidence could be attributed to a function span.
   */
  symbolsWithBoundary?: number;
  /** Functions that mix two or more non-ubiquitous concerns on their own. */
  mixedSymbols?: number;
  /** The highest concern count carried by any single function. */
  maxSymbolConcerns?: number;
  /** The most concern-heavy functions, most concerns first. Capped. */
  topSymbols?: Array<{ symbol: string; line: number; boundaries: BoundaryKind[] }>;
}

export type PatternKind =
  | "singleton" | "factory" | "observer" | "custom-hook" | "hoc"
  | "context-provider" | "dataclass" | "abc" | "middleware"
  | "god-object" | "long-file"
  /** Database work once per loop pass (core/query-in-loop.ts). */
  | "query-in-loop"
  /** A blocking call inside an async function (`blockingCalls` on the plugin manifest). */
  | "blocking-in-async";

export interface PatternInfo {
  kind: PatternKind;
  name: string;
  filePath: string;
  line: number;
  confidence: "high" | "medium" | "low";
  detail: string;
  /**
   * Performance patterns only: the API routes and named entry points (MCP tools, editor and CLI commands)
   * whose call chain reaches the function holding it, nearest first, over resolved links
   * (core/finding-entries.ts). What decides whether it costs every request or one command run.
   */
  entries?: PatternEntry[];
  /**
   * `query-in-loop` only: what the loop walks, when its header says — the rows of a query (`iterates`, the
   * entity, and `relation` when the ER model relates it to the one queried inside), or a small fixed number of
   * passes (`bound`).
   */
  loop?: { iterates?: string; bound?: number; relation?: string };
  /**
   * What pays for it: `request` when an API route reaches it; else `background` when a message consumer or a
   * scheduled job does (every message, every run); else `command` when a tool or command does.
   */
  role?: "request" | "background" | "command";
  /**
   * `god-object` only: the groups the file's own call graph forms — functions
   * that never call another group — largest first, with what moving each out
   * would cost (core/seams.ts). Present when there are at least two.
   */
  seams?: FileSeam[];
}

/** One group a god file could split into, and what moving it out costs. */
export interface FileSeam {
  /** Its functions, by declaration line (capped; `functionCount` is the total). */
  functions: string[];
  functionCount: number;
  /** Lines its functions span — what moves. */
  lines: number;
  /** Boundaries its functions touch, from the file's responsibility evidence. */
  boundaries: BoundaryKind[];
  /** Functions no other file was seen calling: they move without touching another file. */
  moves: number;
  /** Functions other files call or import: moving them changes those files. */
  externalFacing: number;
  /** Distinct files calling into the group. */
  callerFiles: number;
}

/** An entry point whose call chain reaches a pattern's function. */
export interface PatternEntry {
  kind: "route" | EntryPointInfo["kind"];
  /** `GET /orders` for a route; the tool, command id or subcommand otherwise. */
  entry: string;
  /** The file that declares the route or registers the entry point. */
  file: string;
  /** Calls from the entry to the pattern's function. */
  distance: number;
  confidence: Confidence;
}

export type SecuritySeverity = "critical" | "high" | "medium" | "low";
export type SecurityCategory =
  | "hardcoded-secret" | "sql-injection" | "xss" | "eval-exec"
  | "command-injection" | "debug-statement" | "todo-fixme"
  | "pickle" | "subprocess-shell" | "bare-except"
  | "deserialization" | "xxe" | "weak-crypto" | "insecure-config" | "missing-auth"
  | "path-traversal" | "ssrf" | "open-redirect" | "safe-method-write" | "webhook-unverified" | "missing-rate-limit" | "missing-csrf"
  /** A finding another tool reported (`analyze --import-sarif`) whose weakness has no category here. */
  | "external";

export interface SecurityIssue {
  category: SecurityCategory;
  severity: SecuritySeverity;
  message: string;
  filePath: string;
  line: number;
  snippet: string;
  /** The weakness it is an instance of (`CWE-89`), when one applies. */
  cwe?: string;
  /**
   * The API routes whose handlers reach the function this input-sink finding
   * sits in (`POST /search`, 2 hops), nearest first, over resolved calls.
   * Reachability, not taint. Absent when no route reaches it.
   */
  entries?: Array<{ route: string; file: string; distance: number; confidence: Confidence }>;
  /**
   * A taint finding's steps, source first, sink last: the request parameter
   * or read, each assignment that carried the value, the call it reaches.
   * `file` is set on a step in another file than the finding's (an imported
   * tool's flow). Absent for findings that are not followed from input.
   */
  flow?: Array<{ line: number; note: string; file?: string }>;
  /** The tool that reported it, for a finding imported from another tool's SARIF (`semgrep`, `CodeQL`). */
  tool?: string;
  /** That tool's rule id. */
  ruleId?: string;
}

export interface DuplicateGroup {
  functionName: string;
  occurrences: { filePath: string; line: number; similarity: number }[];
  kind: "name-based" | "structural";
}

export type ArchLayer = "ui" | "components" | "services" | "data" | "utils" | "config" | "test" | "unknown";

export interface LayerViolation {
  sourceFile: string;
  sourceLayer: ArchLayer;
  targetFile: string;
  targetLayer: ArchLayer;
  importSpecifier: string;
  line: number;
  /**
   * The team rule this import breaks (`.clarifydoc/config.json` `rules`), when
   * it is one — absent for the built-in layer-order check.
   */
  rule?: string;
  /** The rule's severity (`error` unless the rule says `warn`). */
  severity?: "error" | "warn";
  /** A `noCycles` rule: the files or `each` elements of the cycle this import closes, sorted. */
  cycle?: string[];
}

export interface BlastSymbolUsage {
  name: string;
  usedByCount: number;
  callers: { file: string; line: number }[];
}

/** One screen whose execution transitively reaches the blast subject file. */
export interface TraceImpactScreen {
  /** Screen display name (ScreenInfo.name). */
  name: string;
  /** The screen's file — deep-link target for the Screens & UI tab. */
  file: string;
  /** Frontend route serving the screen, when routed. */
  route: string | null;
}

/** One API route whose handler transitively calls into the blast subject file. */
export interface TraceImpactRoute {
  /** HTTP method, uppercased; null when the route matches any verb. */
  method: string | null;
  path: string;
  /** File declaring the route. */
  file: string;
  line: number;
}

/**
 * Cross-tier projection of a file's blast radius, computed over the SAME
 * symbol-link graph Call Traces use (including the synthetic HTTP and MQ
 * edges): upstream, the screens and API routes whose execution transitively
 * reaches a symbol in this file; downstream, the ER entities and message-broker
 * destinations the file's symbols ultimately touch. Lists are capped — the
 * `*Count` fields carry the true totals.
 */
export interface TraceImpactInfo {
  screens: TraceImpactScreen[];
  screenCount: number;
  routes: TraceImpactRoute[];
  routeCount: number;
  /** ER entity names (EntityGraph node names) transitively read/written. */
  entities: string[];
  entityCount: number;
  /** Broker destinations (exchange/queue/topic) transitively published to or consumed from. */
  queues: string[];
  queueCount: number;
}

/**
 * What KIND of thing a file is, for the purpose of deciding what changing it
 * means. The import graph answers "how much depends on this"; the category
 * answers "what sort of dependency", which is what decides whether 5 importers
 * is critical (a contract others are typed against) or unremarkable (a util).
 *
 * `unknown` is a legitimate outcome, not a failure — a file with no
 * classifying evidence says so instead of being guessed at.
 */
export type RiskCategory =
  | "foundation" | "boundary" | "flow" | "shared" | "localized" | "unknown";

/**
 * The interpretation layer over `BlastRadiusInfo`'s counts: a category, a
 * level derived from the thresholds that apply TO THAT CATEGORY, and the
 * rules that produced both.
 *
 * `reasons` is the point of the whole record. A category without the rule
 * that fired is astrology, so every verdict names its evidence the way
 * `RefactorPressureInfo.drivers` does, using the same stable-identifier
 * idiom (`REASON_LABELS` / `describeReasons` in `core/risk-verdict.ts`).
 */
export interface RiskVerdict {
  category: RiskCategory;
  /**
   * Reuses `BlastRadiusInfo["level"]`'s union deliberately — the codebase
   * already carries five scoring idioms and this is not a sixth. Derived
   * per-category, so it does NOT track the sibling `level` field.
   */
  level: "critical" | "high" | "medium" | "low";
  /** One deterministic sentence built from the category and the counts. */
  summary: string;
  /**
   * The user-visible behaviour that changes with this file — screen names,
   * route labels, entities written.
   *
   * Carries no SOURCE FILE reference: this is free text, so a file path
   * embedded here could not be lifted into a `files[]` page id by
   * `normalizeProject`, and would drift the moment a file moved. The paths
   * are already carried structurally on `traceImpact`. Route strings are
   * fine even when they look path-like (`/api/orders`, and static-site
   * screens whose route IS an html path) — routes are plain strings
   * everywhere in the artifact and are never page-encoded.
   *
   * Capped; `traceImpact`'s `*Count` fields hold the totals.
   */
  behaviourAtRisk: string[];
  /** Every rule that fired, in cascade order. Never empty. */
  reasons: string[];
  /** 0..1 — share of the evidence sources that were available for this file. */
  confidence: number;
}

export interface BlastRadiusInfo {
  filePath: string;
  directDependents: number;
  transitiveDependents: number;
  impactScore: number;
  centrality: number;
  level: "critical" | "high" | "medium" | "low";
  affectedFiles: string[];
  transitiveFiles: string[];
  dependsOn: string[];
  exportedSymbols: BlastSymbolUsage[];
  changeRisk: "safe" | "moderate" | "dangerous";
  maxDepth: number;
  /** Per-class type-usage breakdown for classes defined in THIS file.
   *  Omitted (or empty) when the file defines no classes. Lets the report
   *  answer "if I change User, what's the blast?" alongside the existing
   *  file-level answer. */
  typeUsages?: TypeUsageSummary[];
  /** Cross-tier reach: screens/routes that depend on this file and the
   *  entities/queues it touches. Omitted when the file has none. */
  traceImpact?: TraceImpactInfo;
  /**
   * How much must be read to edit this file safely: its two-hop neighborhood
   * over imports AND importers (blast radius looks downstream only), with a
   * size estimate. An agent-facing signal — a file whose neighborhood is 40
   * files and 30k tokens cannot be changed from a single context window.
   */
  contextBurden?: ContextBurden;
  /**
   * The verdict over the counts above: what kind of file this is, how bad
   * changing it is FOR THAT KIND, and why. Additive — `changeRisk` and
   * `level` keep their existing meaning and values. Omitted on artifacts
   * written before the classifier existed.
   */
  verdict?: RiskVerdict;
}

export interface ContextBurden {
  /** Distinct files within two hops in either direction, excluding the file itself. */
  files: number;
  /** Physical lines of the file plus its neighborhood; null when no line counts are known. */
  lines: number | null;
  /** Rough token estimate (≈10 tokens per line); null when `lines` is null. */
  estimatedTokens: number | null;
}

export interface HealthScore {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  penalties: { reason: string; points: number }[];
  /** The scoring model (`rates-v2`); absent on scores from older runs. */
  model?: string;
  /** N: the authored non-test file count every rate is over (at least 50). */
  basis?: number;
  /** Every graded dimension, deducting or not, with the rate behind it. */
  dimensions?: { id: string; count: number; rate: number; points: number; cap: number }[];
}

export interface Suggestion {
  priority: "critical" | "high" | "medium" | "low";
  category: string;
  message: string;
  filePath?: string;
  actionable: string;
  /** The concrete signals behind the suggestion (e.g. refactor-pressure drivers). Optional. */
  evidence?: string[];
  /** 0..1 — how much of the signal the suggestion rests on was actually available. Optional. */
  confidence?: number;
}

// ─── Refactor pressure (refactor-pressure.ts) ──────────────────────────────

/** Recommendation band derived from the score and any fired gates. */
export type RefactorPressureBand = "none" | "observe" | "suggest" | "strong" | "urgent";

/**
 * One file's composite refactor pressure: where to refactor FIRST. Combines
 * complexity, size, mixed concerns, coupling and churn into a 0–100 score
 * with an explicit list of the drivers behind it, the hard gates that fired
 * and a confidence that says how much of the signal was available (no git
 * history, no complexity for regex-only languages, …).
 */
export interface RefactorPressureInfo {
  filePath: string;
  /** 0–100, one decimal. */
  score: number;
  band: RefactorPressureBand;
  /** Normalized 0–100 sub-scores; `null` when that signal was unavailable for the project. */
  components: {
    complexity: number | null;
    size: number | null;
    responsibility: number;
    coupling: number;
    churn: number | null;
  };
  /** Evidence categories that pushed the score (stable identifiers). */
  drivers: string[];
  /** Hard gates that fired regardless of the weighted score. */
  gates: string[];
  /** 0..1 — share of the component weight that had evidence. */
  confidence: number;
  /**
   * Where inside the file the concerns sit, when a responsibility profile could
   * attribute them to functions. Turns "this file mixes four concerns" into
   * advice that names the functions to split off.
   */
  concentration?: {
    symbolsWithBoundary: number;
    mixedSymbols: number;
    topSymbols: Array<{ symbol: string; line: number; boundaries: BoundaryKind[] }>;
  };
  evidence: {
    loc: number | null;
    functions: number;
    maxCyclomatic: number;
    totalCyclomatic: number;
    maxCognitive: number | null;
    totalCognitive: number | null;
    maxNestingDepth: number | null;
    concernCount: number;
    roles: WorkflowRole[];
    directDependents: number;
    transitiveDependents: number;
    dependsOn: number;
    inCycle: boolean;
    layerViolations: number;
    commits: number | null;
    authors: number | null;
  };
}

export type SubProjectKind =
  | "node"
  | "dotnet"
  | "cmake"
  | "delphi"
  | "lazarus"
  | "java-maven"
  | "java-gradle"
  | "rust"
  | "go"
  | "python"
  | "php"
  | "ruby"
  | "swift"
  | "dart"
  | "elixir"
  | "root";

export interface SubProject {
  id: string;
  name: string;
  root: string;
  kind: SubProjectKind;
  /**
   * The name the sub-project's own manifest declares (`lemmy_db_views_site`
   * in its Cargo.toml, `@scope/ui` in package.json, a go.mod `module` path):
   * what a sibling sub-project writes to import it. Absent when no manifest
   * at the root declares one.
   */
  packageName?: string;
  /** The package ecosystem that name belongs to (`cargo`, `npm`, `go`, …) — the matching rules are the ecosystem's. */
  packageEcosystem?: PackageEcosystem;
  /**
   * Further packages the sub-project's manifests declare: the name another
   * ecosystem's manifest at the same root gives (a go.mod `module` beside a
   * package.json `name`), and — with `root` — a package a manifest maps to a
   * directory of this repository (go.mod `replace … => ./dir`). Absent when
   * `packageName` is the only one.
   */
  packages?: Array<{ name: string; ecosystem: PackageEcosystem; root?: string }>;
  markers: string[];
  /**
   * Frameworks/ORMs detected from this sub-project's own manifests (its nested
   * `package.json`, `Gemfile`, `*.csproj`, …). A repo whose build files live in
   * sub-project roots rather than the analyzed root only surfaces them here.
   */
  frameworks?: FrameworkDetection[];
}

/**
 * Layer-1 dead-code findings: what a static walk from the project's entry
 * points cannot reach. Precision over recall throughout — a file or export
 * the analysis cannot account for is left out, never flagged.
 */
export interface DeadCodeReport {
  /** Languages whose files were judged (their plugin declares a reachability model). */
  languages: Language[];
  /** Files judged: authored, non-test, in a judged language, in a project with an entry point. */
  judgedFiles: number;
  /** Judged files that are entry points themselves (toolchain manifest or framework convention). */
  entryFiles: number;
  /** Those entry files and why each is one (`package.json main`, `manage.py`), at most {@link DEAD_CODE_ENTRY_LIMIT}. */
  entries?: Array<{ filePath: string; reason: string }>;
  /**
   * Projects (sub-project roots, "" for the analyzed root) holding files of a
   * judged language that were NOT judged, and why — a project with no
   * detectable entry point for those languages has nothing to measure
   * reachability from. Anchoring is per language: one row per project and
   * language model.
   */
  skippedProjects?: Array<{ root: string; files: number; languages?: Language[]; reason: string }>;
  /**
   * Imports that look local (`@/x`, `~/x`) but name nothing analyzed. Each
   * may hide an edge, so unreachable files in a project with any are AMBIGUOUS.
   */
  unresolvedImports?: number;
  files: UnreachableFile[];
  exports: UnusedExport[];
  /**
   * Import bindings nothing in their file mentions (`ImportInfo.unused`), in
   * authored non-test files — for the languages whose plugin reports them.
   * Capped at {@link UNUSED_IMPORTS_LIMIT} rows; `unusedImportCount` is the total.
   */
  unusedImports?: Array<{ filePath: string; line: number; source: string; names: string[] }>;
  unusedImportCount?: number;
}

/** Rows of `DeadCodeReport.entries` kept in the summary. */
export const DEAD_CODE_ENTRY_LIMIT = 200;

/** Rows of `DeadCodeReport.unusedImports` kept in the summary. */
export const UNUSED_IMPORTS_LIMIT = 500;

export interface UnreachableFile {
  filePath: string;
  /**
   * INFERRED — nothing reaches it. AMBIGUOUS — nothing reaches it through an
   * import, but a reachable file names it (a call, type or tag spelled like
   * its basename), so it may be loaded by convention (auto-import, global
   * registration) the resolver cannot see.
   */
  confidence: Confidence;
  /** Other unreachable files that import it; 0 = top of a dead cluster, the one to delete first. */
  deadImporters: number;
  lineCount?: number;
}

export interface UnusedExport {
  filePath: string;
  name: string;
  kind: ExportInfo["kind"];
  line: number;
  /** Still referenced inside its own file: drop the `export`, don't delete the declaration. */
  usedInFile: boolean;
}

/** Project-level summary */
/**
 * What produced this analysis and what it was able to see.
 *
 * A consumer — an MCP client, the viewer, a downstream ingester, or a person
 * diffing two runs — could not tell which extractor version wrote a summary
 * (that lived only in `manifest.json`, and only on incremental runs), whether
 * a config was found and applied, whether git history was available, or
 * whether any file silently fell back to regex. Config validation warnings
 * were computed and then printed to a verbose console, which is exactly where
 * nobody analyzing from an editor or through MCP would ever see them.
 */
export interface AnalysisProvenance {
  extractorVersion: string;
  /** On-disk normalization format of `project-summary.json`. */
  schemaVersion: number;
  toolVersion: string;
  incremental: boolean;
  /** Files reused from the cache on an incremental run. */
  reusedFiles?: number;
  config: {
    /** Whether `.clarifydoc/config.json` was found. */
    present: boolean;
    /** Validation and lint messages; empty when the file is absent or clean. */
    warnings: string[];
  };
  signals: {
    lsp: "applied" | "absent";
    gitHistory: "applied" | "disabled" | "skipped";
    /** Why git history was skipped (not a repository, shallow clone, …). */
    gitSkipReason?: string;
  };
  /** Files carrying extractor warnings from schema validation. */
  extractorWarningFiles: number;
  /** Files whose tree-sitter parse failed and fell back to regex, by language. */
  parseFallbacks?: Record<string, number>;
  /**
   * Wall-clock milliseconds per pipeline stage, in order — where a run spends
   * its time, so the expensive incremental passes can be found. Left out of
   * `--stable-output` artifacts (it differs every run).
   */
  stageTimings?: Array<{ stage: string; ms: number }>;
}

export interface ProjectAnalysis {
  projectRoot: string;
  detectedFrameworks: FrameworkDetection[];
  /** Detected sub-projects (monorepo packages, multi-language repos, etc.). */
  subProjects: SubProject[];
  /** Map from file path to owning sub-project id. */
  fileProjects: Record<string, string>;
  files: string[];
  componentGraph: Record<string, string[]>;
  linkGraph: LinkInfo[];
  interactiveElements: (InteractiveElementInfo & { filePath: string })[];
  events: (EventInfo & { filePath: string })[];
  /**
   * Every route in the project, one row per (sub-project, method, path,
   * version set). `projectId` names the sub-project the declaring file
   * belongs to — the same endpoint hosted by two services is two rows.
   */
  routeMap: (RouteInfo & { filePath?: string; projectId?: string; requestSchema?: JsonSchemaNode; responseSchema?: JsonSchemaNode })[];
  /**
   * Outbound API calls — HTTP calls made FROM client code to external or internal endpoints.
   * Aggregated from each file's `dataSources` where `kind === "api-call"`.
   */
  apiCalls: (DataSourceInfo & { filePath: string })[];
  /**
   * The hosts outside this analysis the code calls, grouped by the
   * third-party service each belongs to (`Stripe` for `api.stripe.com`), or
   * by the host when it is not a known one (core/external-services.ts).
   */
  externalServices?: Array<{ name: string; known: boolean; hosts: string[]; calls: number; files: string[] }>;
  /** MCP tools, editor and CLI commands the code registers: entry points that are not routes. */
  entryPoints?: Array<EntryPointInfo & { filePath: string; projectId?: string }>;
  /**
   * How each sub-project is built, tested and started, as its own files say (package.json scripts,
   * go.mod, Cargo.toml, …) — per language plugin, the first plugin to name a kind for a root wins.
   */
  projectCommands?: Array<{ projectId: string; root: string; kind: "build" | "test" | "start" | "dev" | "lint"; command: string; source: string }>;
  screens: ScreenInfo[];
  /**
   * Resolved frontend→backend links: each outbound `api-call` matched to the
   * inbound `api` route that serves it. Joins the two halves of the
   * screen→API→DB chain. Omitted when empty (e.g. pure frontend/backend repos).
   */
  apiRouteLinks?: ApiRouteLink[];
  /**
   * For each slot of an API call's URL, where its value comes from: a screen's
   * route parameter, a literal, or unknown — followed back through the calls
   * that hand it on (core/param-origins.ts). Capped per call; absent when no
   * plugin reports argument origins.
   */
  paramOrigins?: ParamOrigin[];
  /** What the cross-tier linker did with every call — links, refusals, unmatched, by caller role. */
  apiRouteLinkStats?: ApiRouteLinkStats;
  /** Request bodies that disagree with the route they reach (EXTRACTED links only). */
  contractFindings?: ContractFinding[];
  /**
   * Sub-project → sub-project runtime dependencies: HTTP calls and broker
   * messages that cross between them, with the endpoints behind each and the
   * deployment edge that agrees. Omitted when nothing crosses.
   */
  projectDependencies?: ProjectDependency[];
  /** The names each sub-project answers to at runtime — what call origins resolve hosts through. */
  serviceAddresses?: ServiceAddress[];
  /** Forwarding rules (dev proxies, gateway routes), each with the sub-project requests arrive at. */
  proxyRules?: Array<ProxyRule & { project: string }>;
  /** Per-file child-component usages (JSX/Vue-template tags), with import source as `target`. */
  componentUsage?: (SubComponentInfo & { filePath: string })[];
  symbolLinks: SymbolLink[];
  /** Dynamic-import "opens component" relationships (dialogs, lazy components)
   *  derived from symbolLinks. Drives the Screens & UI "opens" / "opened by"
   *  cross-links. Omitted when empty. */
  componentLaunches?: ComponentLaunch[];
  lspStats?: LspStats;
  analyzedAt: string;
  /** The commit the source was at (git work trees, when git history is read). */
  sourceRevision?: { commit: string; branch: string | null; dirty: number };
  /** How much of the code was read: parse errors, local imports that resolved, frameworks that yielded nothing (core/coverage.ts). */
  coverage?: import("../core/coverage.js").AnalysisCoverage;
  /**
   * Edges of `componentGraph` that only type-only imports state and no call
   * goes along (core/import-kinds.ts): no runtime dependency, so cycles are
   * judged without them.
   */
  typeOnlyEdges?: Record<string, string[]>;
  /**
   * Edges of `componentGraph` that only dynamic imports state (`import("./x")`,
   * core/import-kinds.ts): loaded on demand, not when the importer loads, so
   * cycles are judged without them, like type-only edges.
   */
  dynamicImportEdges?: Record<string, string[]>;
  /** Credentials found in git history's added lines (`analyze --history-secrets`, core/history-secrets.ts), masked. */
  historySecrets?: import("../core/history-secrets.js").HistorySecretsReport;
  /** What the project's Markdown names — paths, routes, class members — that the tree no longer bears out (core/doc-drift.ts). */
  docDrift?: import("../core/doc-drift.js").DocDriftReport;
  /** Test coverage from the reports a test run wrote (core/test-coverage.ts) — per file and per function. */
  testCoverage?: import("../core/test-coverage.js").TestCoverageReport;
  /** Other tools' SARIF this analysis joined (`--import-sarif`): results read, and how many landed on analyzed files. */
  importedFindings?: Array<{ source: string; tool: string; results: number; matched: number }>;

  // Advanced analysis (optional)
  complexity?: FileComplexityInfo[];
  patterns?: PatternInfo[];
  securityIssues?: SecurityIssue[];
  duplicates?: DuplicateGroup[];
  layerViolations?: LayerViolation[];
  blastRadius?: BlastRadiusInfo[];
  healthScore?: HealthScore;
  suggestions?: Suggestion[];
  /** Per-file git activity in the history window; absent for non-repos,
   *  shallow clones, or `--no-git-history` runs. */
  fileChurn?: FileChurnInfo[];
  /** Files that change together in history (see `CoChangePair`), strongest first, capped at 500. */
  coChange?: CoChangePair[];
  /** The project's CODEOWNERS rules, in file order (the last match wins). */
  codeOwners?: { file: string; rules: Array<{ pattern: string; owners: string[] }> };
  /** Top churn × complexity hotspots (derived from fileChurn + complexity). */
  hotspots?: HotspotInfo[];
  /** Per-file boundary/concern profile for files that touch at least one
   *  boundary (responsibility-profile.ts). Omitted when empty. */
  responsibilityProfiles?: ResponsibilityProfile[];
  /** Files with measurable refactor pressure, highest first (refactor-pressure.ts). Omitted when empty. */
  refactorPressure?: RefactorPressureInfo[];
  fileLayerMap?: Record<string, ArchLayer>;
  /** Why each file is in its layer: its name, its folder, a config rule, or what it does (it declares routes, defines entities…). */
  fileLayerReasons?: Record<string, string>;
  /**
   * The other layers what a file does puts it in, beside its own: an API
   * controller that also queries the database is both. Only declared facts
   * count (routes, entities, queries, templates), never imports.
   */
  fileLayerAlternates?: Record<string, Array<{ layer: ArchLayer; reason: string }>>;
  /** Files a path or name rule placed in a layer none of their content agrees with — a `utils/` file that queries the database. */
  fileLayerConflicts?: Array<{ file: string; layer: ArchLayer; evidence: string }>;
  /** What produced this analysis and what it could see. Omitted on old artifacts. */
  provenance?: AnalysisProvenance;
  /** Auto-detected generated/library barrel roots (e.g. kubb output dirs). */
  generatedRoots?: string[];
  /** Files under a generated root that nothing outside that tree imports (dead code). */
  unusedFiles?: string[];
  /**
   * Authored code no entry point reaches, and exports nothing imports
   * (core/dead-code.ts `analyzeReachability`). Only languages whose plugin
   * declares a `reachability` model are judged. Omitted when nothing was.
   */
  deadCode?: DeadCodeReport;
  /** Aggregate provenance counts across symbolLinks for at-a-glance quality assessment. */
  confidenceCounts?: { extracted: number; inferred: number; ambiguous: number };
  /** Paths the discovery layer silently skipped because their names look like credentials. */
  skippedSensitive?: string[];
  /**
   * Symlinked source paths discovery refused to read — the link leaves the
   * project root, dangles, or names a non-file. Linked directories are never
   * descended at all.
   */
  skippedSymlinks?: string[];
  /** Louvain-detected communities (community ID → file paths). Largest first. */
  communities?: Record<string, string[]>;
  /**
   * Each community's name — the folder most of its files share, relative to
   * its sub-project — with the subsystem and system above it and a slug that
   * survives renumbering (core/community-names.ts).
   */
  communityNames?: Record<string, import("../core/community-names.js").CommunityName>;
  /** Cohesion ∈ [0, 1] for each community ID — intra-community edges / max possible. */
  cohesion?: Record<string, number>;
  /** Top files by combined in+out degree — the structural core of the project. */
  godNodes?: Array<{ file: string; degree: number }>;
  /** Cross-community / low-confidence / peripheral→hub links worth a second look. */
  surprisingConnections?: Array<{
    source: string;
    target: string;
    confidence?: Confidence;
    relation: string;
    score: number;
    reason: string;
  }>;
  /** Auto-generated exploration questions derived from graph topology. */
  suggestedQuestions?: Array<{
    type: "ambiguous-edge" | "bridge-node" | "isolated-node" | "low-cohesion";
    question: string;
    why: string;
  }>;
  /** Class-level dependency graph for the Architecture tab's Data Models mode. */
  classGraph?: ClassGraph;
  dataAccessGraph?: DataAccessGraph;
  /** Entity-relationship graph for the "Data Model" (ER diagram) view. */
  entityGraph?: EntityGraph;
  /** DB accesses attributed to the function that contains them — bridges the
   *  symbol-level Call Traces to the entity-level Data Model. Omitted when empty. */
  symbolDataAccess?: SymbolDataAccess[];
  /** Transitive "dataflow-lite" reach: per-symbol summary of the data-access
   *  effects each function reaches through the call graph (data-flow-reach.ts).
   *  Omitted when the project has no data access. */
  symbolReach?: SymbolReachSummary[];
  /** Source→sink rows: UI/route entry points that transitively reach a data
   *  effect (e.g. handlers that reach a DB write). Omitted when empty. */
  dataFlows?: DataFlowPath[];
  /** Detected ORM/DB migrations across known ecosystems. Omitted when empty. */
  migrations?: MigrationInfo[];
  /**
   * Full third-party dependency inventory across every manifest ecosystem,
   * cross-referenced against the imports in analyzed code. Drives the report's
   * Dependencies view and feeds the framework detector. Omitted when the
   * project declares no external dependencies.
   */
  externalPackages?: ExternalPackage[];
  /**
   * Deployment topology parsed from container-orchestration manifests
   * (docker-compose/compose files): the deployed services, the infrastructure
   * they attach to, and the service→service edges evidenced by injected
   * API keys / connection strings / URLs. Drives the Architecture tab's
   * Context (C1) and Deployment (C2) levels. Omitted when no compose files.
   */
  deployment?: DeploymentModel;
  /**
   * Environment variables the code reads, where, and which deployed services
   * set them (`core/env-vars.ts`) — names only, never values.
   */
  envVars?: Array<{ name: string; readBy: Array<{ file: string; line: number; project?: string }>; setBy: Array<{ service: string; file: string }> }>;
  /** The deploy steps of the repository's CI pipelines (`core/ci-pipelines.ts`): what ships, from where, on what trigger. */
  ciDeploys?: CiDeploy[];
}

/** One deploy step of a CI pipeline. */
export interface CiDeploy {
  /** The pipeline file (repo-relative). */
  file: string;
  /** The CI system, or the GitOps tool that deploys it (`flux`, `argo`, `kustomize`, `terraform` — `core/gitops-releases.ts`). */
  provider: "github" | "gitlab" | "azure" | "circleci" | "bitbucket" | "flux" | "argo" | "kustomize" | "terraform";
  /** The workflow's `name:`, when it states one. */
  workflow?: string;
  job: string;
  line: number;
  /** What runs it: `push main`, `tag v*`, `pull_request`, `manual`, `schedule`, a GitLab rule. */
  triggers: string[];
  kind: "docker" | "kubernetes" | "helm" | "terraform" | "serverless" | "cdk" | "sam" | "package" | "pages" | "cloud";
  /** What it ships, as a repo-relative path: build context, manifests, chart, working directory. */
  path?: string;
  /** The sub-project that path is in. */
  project?: string;
  /** The step as written (the command line, or the action). */
  via: string;
}

// ─── Deployment topology (compose files) ───────────────────────────────────

/** Broad role of a deployed service, classified from its image/name. */
/** One deployable resource code declares (`FileAnalysis.deployedResources`). */
export interface DeployedResourceFact {
  /** As deployed: the queue/table/function name the code gives it, else its construct id. */
  name: string;
  kind: DeployedServiceKind;
  /** `sqs`, `sns`, `dynamodb`, `s3`, `rds`, `lambda`, … */
  family?: string;
  line: number;
  /** A function's handler as the runtime reads it (`users.list`). */
  handler?: string;
  /**
   * The project it runs: a project path relative to the declaring file
   * (`../League.Api/League.Api.csproj`, `../web`), or a project name matched
   * with its punctuation ignored (Aspire's `Projects.League_Api` → `League_Api`).
   */
  runs?: string;
  /** Env keys the resource is given (values only when literal). */
  env?: Record<string, string>;
  /** What it is wired to: a grant, an event source or an env reference, by the other resource's `name`. */
  edges?: Array<{ to: string; kind: "bus" | "db" | "http"; via: string }>;
}

export type DeployedServiceKind =
  | "app"
  | "datastore"
  | "queue"
  | "cache"
  | "proxy"
  | "observability"
  | "other";

export interface DeployedService {
  /** Compose service name — unique across all parsed compose files. */
  name: string;
  /** Repo-relative posix path of the compose file that declared it (primary). */
  composeFile: string;
  /**
   * Every compose file that declares this service. Repos often carry several
   * deployment stacks (legacy + current, base + local variant) — this is what
   * lets the report filter the Deployment view down to one stack.
   */
  composeFiles?: string[];
  image?: string;
  /** Joined entrypoint/command, when declared (e.g. "dotnet Plan.API.dll"). */
  entrypoint?: string;
  kind: DeployedServiceKind;
  /** Infra family for merging instances (postgres, firebird, rabbitmq, redis…). */
  family?: string;
  /** Short tech label: entrypoint artifact or image tail. */
  tech?: string;
  /**
   * Environment values that are URLs (`ORDERS_URL: http://orders:8080`),
   * credentials stripped; every other value is left out. What a call's
   * `process.env.ORDERS_URL` or configuration key resolves to at runtime.
   */
  urlEnv?: Record<string, string>;
  /** Host ports compose maps onto the service (`"5101:8080"` → 5101): what `localhost:5101` reaches. */
  hostPorts?: number[];
  /** Other DNS names the service answers to: k8s Service names, compose `hostname`/`container_name`. */
  aliases?: string[];
  /** Matched SubProject id — links the deployed unit to its source code. */
  project?: string;
  /** Attaches to a message bus (EventBus/AMQP/Kafka env vars present). */
  bus?: boolean;
  /** Uses a shared cache (Redis/Memcached env vars present). */
  cache?: boolean;
  /** Logical databases named by this service's connection-string env vars. */
  databases?: Array<{ name: string; primary: boolean }>;
  /** Databases hosted BY this service (datastore kind), e.g. POSTGRES_MULTIPLE_DATABASES. */
  hostedDatabases?: string[];
  /** The Dockerfile that builds it (repo-relative): a compose `build:`, or a Dockerfile no compose file uses. */
  dockerfile?: string;
  /** The repository file its command starts (`CMD ["python", "app/main.py"]` → `app/main.py`). */
  entryFile?: string;
  /** Names of the environment variables it is given (compose, Kubernetes, Dockerfile `ENV`) — never their values. */
  envKeys?: string[];
}

export interface DeploymentEdge {
  /** Compose service name, or an `ext:` external id. */
  from: string;
  to: string;
  kind: "http" | "db" | "bus" | "external" | "depends";
  /** Human hint: logical db name, external host, … */
  label?: string;
  /** Env var that evidenced the edge. */
  via?: string;
}

/** A system outside the compose network, evidenced by env URLs/issuers. */
export interface DeploymentExternal {
  /** Stable id, `ext:<slug>`. */
  id: string;
  name: string;
  /** Literal URL when one was present in the env (not a ${VAR} placeholder). */
  url?: string;
}

export interface DeploymentModel {
  /** Repo-relative posix paths of every compose file that contributed. */
  composeFiles: string[];
  services: DeployedService[];
  externals: DeploymentExternal[];
  edges: DeploymentEdge[];
}

export interface FrameworkDetection {
  id: string;
  name: string;
  confidence: "high" | "medium" | "low";
  detectedVia: string;
}

/** Package-manager ecosystem a dependency was declared in. */
export type PackageEcosystem =
  | "npm"
  | "nuget"
  | "pypi"
  | "maven"
  | "gradle"
  | "composer"
  | "cargo"
  | "go"
  | "rubygems"
  | "pub"
  | "swiftpm"
  | "cocoapods"
  | "vcpkg"
  | "conan"
  | "cpan"
  | "luarocks"
  | "hex"
  | "hackage"
  | "clojars"
  | "psgallery"
  | "cran"
  | "julia"
  | "shards"
  | "zig"
  | "opam"
  | "raku"
  | "racket"
  | "quicklisp"
  | "haxelib"
  | "conda"
  | "nimble"
  | "dub"
  | "vpm"
  | "git";

/** How a dependency is consumed (production vs tooling-only). */
export type PackageScope = "prod" | "dev" | "peer" | "optional";

/**
 * Best-effort functional bucket for an external dependency. `framework` and
 * `orm` mirror the dedicated detectors; the rest let the report group the long
 * tail (build tooling, test runners, HTTP clients, …) instead of one flat list.
 */
export type PackageCategory =
  | "framework"
  | "frontend"
  | "orm"
  | "database"
  | "http"
  | "state"
  | "ui"
  | "testing"
  | "build"
  | "lint"
  | "auth"
  | "validation"
  | "logging"
  | "messaging"
  | "serialization"
  | "graphql"
  | "grpc"
  | "cloud"
  | "types"
  | "util"
  | "cache"
  | "filesystem"
  | "email"
  | "other";

/**
 * One external dependency declared in a project manifest (package.json,
 * *.csproj, go.mod, …), cross-referenced against the code that actually imports
 * it. This is the inventory the framework detector consumes and the report
 * surfaces — ClarifyDoc should know not just *which* frameworks a repo
 * uses but its full third-party surface and how much of it is live.
 */
export interface ExternalPackage {
  /** Canonical package name in its ecosystem (`react`, `gorm.io/gorm`, `Microsoft.EntityFrameworkCore`). */
  name: string;
  /**
   * Declared version / range spec, when the manifest carries one; for
   * ecosystems with a lockfile fallback (rubygems), the lock's exact resolved
   * version when the manifest declares none.
   */
  version: string | null;
  ecosystem: PackageEcosystem;
  scope: PackageScope;
  category: PackageCategory;
  /**
   * Whether any analyzed source file imports this package. `undefined` means
   * usage could not be reliably mapped for this ecosystem (e.g. Maven/NuGet,
   * where imports are namespaces, not artifact coordinates) — we never assert
   * "unused" when the import→package mapping is unreliable.
   */
  used?: boolean;
  /** Number of analyzed files importing it (only set when `used` is known). */
  usageCount?: number;
  /**
   * Used without being imported: run by a manifest script (`"build": "tsc"`),
   * named in a tool's config (`loader: "ts-loader"`, a Babel preset), or the
   * types of an imported package (`@types/react`). Such a package is `used`.
   */
  usedBy?: Array<"script" | "config" | "types">;
  /** Manifest the dependency was declared in, relative to the project root. */
  declaredIn: string;
  /**
   * The version the package manager installed, read from the lockfile beside
   * the manifest (package-lock.json, yarn.lock, poetry.lock, uv.lock,
   * Pipfile.lock, Cargo.lock, composer.lock, Gemfile.lock) — exact, where
   * `version` is the declared range. Absent without a lockfile.
   */
  resolvedVersion?: string;
  /**
   * The licence the lockfile records for the installed package (SPDX, as
   * written: `MIT`, `Apache-2.0`, `(MIT OR Apache-2.0)`). Absent where the
   * ecosystem's lockfile carries none.
   */
  license?: string;
  /**
   * Known vulnerabilities of `resolvedVersion` (or an exact `version`), from
   * OSV — only when the analysis ran with `--osv`.
   */
  advisories?: Array<{ id: string; summary?: string; severity?: string; aliases?: string[] }>;
  /**
   * Every manifest declaring it, when there are several (`web/package.json`
   * and `admin/package.json`), each with its own version spec — `version` and
   * `declaredIn` are the first. Absent for a package declared once.
   */
  declarations?: Array<{ version: string | null; declaredIn: string; scope: PackageScope }>;
  /** The declarations name different versions: `web/` axios ^0.21, `admin/` axios ^1.6. */
  versionSkew?: boolean;
}

/** Create an empty FileAnalysis for a given file */
export function createEmptyAnalysis(
  filePath: string,
  language: Language,
): FileAnalysis {
  return {
    filePath,
    language,
    frameworks: [],
    projectId: "root",
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    routes: [],
    dataSources: [],
    dataMutations: [],
    subComponents: [],
    interactiveElements: [],
    templateTree: [],
    events: [],
    screens: [],
  };
}

/** One schema change a migration states. Tables and columns as written, unquoted. */
export interface SchemaOp {
  op: "create-table" | "drop-table" | "rename-table" | "add-column" | "drop-column" | "rename-column" | "add-foreign-key";
  table: string;
  column?: string;
  /** The new name (rename-table, rename-column), or the referenced table (add-foreign-key). */
  to?: string;
  /** The column's type (add-column), as written. */
  type?: string | null;
  line: number;
}

/** A step of a taint path: the line and what happened there. */
export interface TaintStep {
  line: number;
  note: string;
}

/** See `FileAnalysis.taintFacts`. */
export interface TaintFacts {
  /** Functions that are not handlers, with the parameters (as argument positions) that reach a sink. */
  summaries: Array<{ name: string; line: number; sinks: Array<{ param: number; line: number; category: SecurityCategory; cwe: string; what: string; callee: string; path: TaintStep[] }> }>;
  /** Handler calls into functions the file does not declare, with the arguments carrying request input. */
  calls: Array<{ line: number; callee: string; args: Array<{ index: number; from: number; path: TaintStep[] }> }>;
}
