import { PYTHON_DOCS } from "../../shared/doc-comment-specs.js";
import { DjangoTemplateUrlResolver } from "./django/template-links.js";
import { extractPythonTypeAliases } from "./type-aliases.js";
import { extractPythonModuleValues } from "./module-values.js";
import { AiosqlQueryResolver } from "./aiosql.js";
import { extractPythonEntryPoints, extractPythonScheduledJobs } from "./entry-points.js";
import type { LanguagePluginMeta, SecurityRule } from "../../../types/language-plugin.js";
import { extendControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { stripPythonNonCode } from "./python-tokenizer.js";
import { extractPythonTypeReferences } from "./type-references.js";
import { pythonCallHooks } from "./call-hooks.js";
import { pypiPackages } from "./packages.js";
import { pythonManifest } from "./manifest.js";
import { PythonExtractor } from "./functions-classes.js";
import { PythonImportExportExtractor } from "./imports-exports.js";
import { PythonDataSourceExtractor } from "./data-sources.js";
import { PythonMutationExtractor } from "./data-mutations.js";
import { PythonEntityExtractor } from "./entities.js";
import { pythonRouteExtractor } from "./routes.js";
import { djangoUrlconfResolver } from "./django/resolver.js";
import { PytestFixtureResolver } from "./pytest-fixtures.js";
import { pythonRequestSchema } from "./request-schema.js";
import { pythonReachability, extractPythonPathReferences } from "./reachability.js";
import { extractPythonDiBindings } from "./di.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";
import { pythonTaint } from "./taint.js";
import { pythonGrpcStub, pythonGrpcService } from "../shared/grpc-stubs.js";

const PYTHON_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "list", "List", "tuple", "Tuple", "dict", "Dict", "set", "Set", "frozenset",
  "Optional", "Union", "Any", "Callable", "Iterable", "Iterator",
  "Generator", "AsyncIterator", "AsyncGenerator", "Awaitable",
  "Type", "ClassVar", "Final", "Literal",
  "bytes", "bytearray", "memoryview",
  "complex", "frozenset",
  "Exception", "BaseException", "ValueError", "TypeError", "KeyError",
  "Mapping", "MutableMapping", "Sequence", "MutableSequence",
  "TypedDict", "NamedTuple", "Protocol",
]);

const SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "command-injection",
    severity: "high",
    pattern: /\bos\.system\s*\(/,
    message: "os.system() is vulnerable to command injection. Use subprocess with shell=False.",
    priority: 40,
  },
  {
    category: "pickle",
    severity: "high",
    pattern: /pickle\.load/,
    message: "pickle.load() can execute arbitrary code. Use JSON or safe alternatives.",
    priority: 41,
  },
  {
    category: "subprocess-shell",
    severity: "high",
    pattern: /subprocess\.\w+\([^)]*shell\s*=\s*True/,
    message: "subprocess with shell=True is vulnerable to command injection.",
    priority: 42,
  },
  {
    // Strings are blanked before matching (`securityPreprocess`), so a SQL
    // string built in place shows as a blank literal followed by `+`, `%` or
    // `.format(` — or as a kept `f` prefix. A placeholder query
    // (`execute("… %s", (uid,))`) passes the values separately and never matches.
    category: "sql-injection",
    severity: "high",
    multiline: true,
    pattern: /\.(?:execute|executemany|executescript|raw|extra)\s*\(\s*(?:[rRbB]?[fF][rRbB]?\s|\s+(?:\+|%\s*[\w(]|\.\s*format\s*\())/,
    message: "Possible SQL injection: the statement is built from values. Pass them as query parameters.",
    priority: 39,
    excludeTest: true,
  },
  {
    category: "deserialization",
    severity: "high",
    pattern: /\byaml\.(?:load|load_all|unsafe_load)\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?C?SafeLoader)|\b(?:shelve\.open|jsonpickle\.decode|dill\.loads?)\s*\(/,
    message: "This loader can instantiate arbitrary objects from its input. Use yaml.safe_load / JSON for anything not fully trusted.",
    priority: 45,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    pattern: new RegExp(String.raw`\bhashlib\.(?:md5|sha1)\s*\((?![^)]*usedforsecurity\s*=\s*False)(?=.*${CREDENTIAL_CONTEXT})|\bDES3?\.new\s*\(|\bARC4\.new\s*\(|\bMODE_ECB\b`),
    message: "Broken or weak cryptography (MD5/SHA-1, DES/RC4, ECB). Use SHA-256+ and AES-GCM; pass usedforsecurity=False for a non-security checksum.",
    priority: 46,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-489",
    severity: "high",
    pattern: /^\s*DEBUG\s*=\s*True\b/,
    message: "Django runs with DEBUG = True: tracebacks, settings and SQL are shown to anyone who triggers an error.",
    priority: 47,
    files: /(?:^|\/)settings(?:\/[^/]+|[^/]*)\.py$/,
  },
  {
    category: "insecure-config",
    cwe: "CWE-489",
    severity: "high",
    pattern: /\.run\s*\([^)]*\bdebug\s*=\s*True/,
    message: "The app server runs in debug mode (an interactive debugger anyone can reach).",
    priority: 48,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-295",
    severity: "high",
    pattern: /\bverify\s*=\s*False\b|["']verify_signature["']\s*:\s*False\b|\bCERT_NONE\b/,
    message: "Certificate or signature verification is turned off (verify=False, verify_signature: False, CERT_NONE).",
    priority: 49,
    excludeTest: true,
    // The `"verify_signature": False` key is a string, which the pre-filter blanks.
    raw: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-352",
    severity: "medium",
    pattern: /@csrf_exempt\b/,
    message: "CSRF protection is switched off for this view.",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "bare-except",
    severity: "medium",
    pattern: /\bexcept\s*:/,
    message: "Bare except catches all exceptions including SystemExit. Specify exception type.",
    priority: 43,
  },
  {
    category: "eval-exec",
    severity: "high",
    pattern: /\bexec\s*\(/,
    message: "exec() executes arbitrary Python code. This is almost always a security risk.",
    priority: 44,
  },
];

export const pythonMeta: LanguagePluginMeta = {
  ...pythonManifest,
  docComments: PYTHON_DOCS,
  knownPackages: pypiPackages,
  routes: pythonRouteExtractor,
  routeResolvers: [djangoUrlconfResolver],
  // A test's parameter is the fixture of that name (module, then conftest.py).
  dispatchResolvers: [new PytestFixtureResolver(), new AiosqlQueryResolver(), new DjangoTemplateUrlResolver()],
  functionsClasses: new PythonExtractor(),
  importsExports: new PythonImportExportExtractor(),
  dataSources: new PythonDataSourceExtractor(),
  dataMutations: new PythonMutationExtractor(),
  entities: new PythonEntityExtractor(),
  builtinTypes: PYTHON_BUILTINS,
  // Typing-only wrappers: `Annotated[UserRepo, Depends(get_repo)]`,
  // `ClassVar[Repo]`, `Final[Repo]`, injector's `Inject[Repo]` — a member call
  // on the value is a call on the wrapped type.
  transparentTypeWrappers: ["Annotated", "ClassVar", "Final", "Inject", "NoInject"],
  complexity: {
    branchNodes: new Set([
      "if_statement", "elif_clause", "while_statement", "for_statement",
      "except_clause", "with_statement", "conditional_expression",
    ]),
    logicalOps: new Set(["and", "or"]),
    nestingNodes: new Set(["lambda", "function_definition"]),
  },
  // Python's statements are the C-family ones under different names, plus two
  // shapes no C-family grammar has: an `elif` chain flattened onto the parent
  // `if` as repeated `alternative` fields, and the `else` that a loop or a
  // `try` runs when it finished without a `break` or an exception.
  controlFlow: extendControlFlow(
    [
      ["elif_clause", "branch"],
      ["except_clause", "catch"],
      ["raise_statement", "throw"],
      ["with_statement", "wrapper"],
      ["match_statement", "switch"],
      ["case_clause", "case"],
      ["function_definition", "nested-function"],
      ["lambda", "nested-function"],
      // Not a statement: `decorated_definition` wraps the function it decorates.
      ["decorated_definition", "wrapper"],
    ],
    // `match` tests patterns in order and runs exactly one arm.
    { fallthrough: false },
  ),
  securityRules: SECURITY_RULES,
  // Strip strings and comments first to avoid false positives.
  securityPreprocess: stripPythonNonCode,
  apiCallRoots: ["requests", "httpx", "aiohttp", "urllib.request", "urllib3", "http.client"],
  dbCallRoots: ["cursor", "session", "engine", "db", "connection", "pool"],
  ast: {
    taint: pythonTaint,
    typeReferences: extractPythonTypeReferences,
    // `__main__` guards, dotted module strings, `.py` paths — what
    // reachability follows besides imports (see reachability.ts).
    pathReferences: extractPythonPathReferences,
    // Container registrations: FastAPI dependency functions, dependency-injector
    // providers, `injector` bindings (see di.ts).
    diBindings: (tree, sourceText) => extractPythonDiBindings(tree, sourceText),
    typeAliases: (tree) => extractPythonTypeAliases(tree),
    // Module and class string constants another module's URL or route reads (see module-values.ts).
    moduleValues: (tree) => extractPythonModuleValues(tree),
    entryPoints: (tree, sourceText) => [...extractPythonEntryPoints(tree, sourceText), ...extractPythonScheduledJobs(tree, sourceText)],
  },
  calls: pythonCallHooks,
  requestSchema: pythonRequestSchema,
  grpcStubService: pythonGrpcStub,
  grpcServiceOf: pythonGrpcService,
  reachability: pythonReachability,
};
