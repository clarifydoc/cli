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
import { pythonRequestSchema } from "./request-schema.js";
import { pythonReachability, extractPythonPathReferences } from "./reachability.js";
import { extractPythonDiBindings } from "./di.js";

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
  knownPackages: pypiPackages,
  routes: pythonRouteExtractor,
  routeResolvers: [djangoUrlconfResolver],
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
  apiCallRoots: ["requests", "httpx", "aiohttp", "urllib", "http.client"],
  dbCallRoots: ["cursor", "session", "engine", "db", "connection", "pool"],
  ast: {
    typeReferences: extractPythonTypeReferences,
    // `__main__` guards, dotted module strings, `.py` paths — what
    // reachability follows besides imports (see reachability.ts).
    pathReferences: extractPythonPathReferences,
    // Container registrations: FastAPI dependency functions, dependency-injector
    // providers, `injector` bindings (see di.ts).
    diBindings: (tree, sourceText) => extractPythonDiBindings(tree, sourceText),
  },
  calls: pythonCallHooks,
  requestSchema: pythonRequestSchema,
  reachability: pythonReachability,
};
