import type { LanguagePluginMeta, SecurityRule } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { stripPythonNonCode } from "./python-tokenizer.js";
import { extractPythonTypeReferences } from "./type-references.js";
import { pythonCallHooks } from "./call-hooks.js";

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
  language: "python",
  parsing: "tree-sitter",
  extensions: [".py", ".pyw"],
  grammar: {
    variants: { python: { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" } },
  },
  builtinTypes: PYTHON_BUILTINS,
  externalModulePrefixes: [
    // Standard library
    "os", "sys", "json", "re", "math", "datetime", "typing", "enum",
    "collections", "itertools", "functools", "pathlib", "hashlib",
    "asyncio", "logging", "unittest", "abc",
    // Common packages
    "fastapi", "flask", "django", "pydantic", "sqlalchemy",
    "requests", "httpx", "aiohttp", "pytest",
    "numpy", "pandas", "scipy",
  ],
  complexity: {
    branchNodes: new Set([
      "if_statement", "elif_clause", "while_statement", "for_statement",
      "except_clause", "with_statement", "conditional_expression",
    ]),
    logicalOps: new Set(["and", "or"]),
  },
  securityRules: SECURITY_RULES,
  // Strip strings and comments first to avoid false positives.
  securityPreprocess: stripPythonNonCode,
  frameworkImportHints: {
    "sqlalchemy": "sqlalchemy",
    "django.db.models": "django-orm",
    "tortoise": "tortoise-orm",
    "peewee": "peewee",
  },
  apiCallRoots: ["requests", "httpx", "aiohttp", "urllib", "http.client"],
  dbCallRoots: ["cursor", "session", "engine", "db", "connection", "pool"],
  // str/list/dict/set/file/stdlib-object methods — `server.login()`, `s.strip()`
  // must never resolve to a project symbol by name coincidence.
  builtinMembers: [
    "append", "extend", "insert", "remove", "pop", "clear", "index", "count",
    "sort", "reverse", "copy", "items", "keys", "values", "update", "setdefault",
    "strip", "lstrip", "rstrip", "lower", "upper", "title", "capitalize",
    "startswith", "endswith", "split", "rsplit", "splitlines", "join", "format",
    "replace", "encode", "decode", "find", "rfind", "isdigit", "isalpha",
    "read", "readline", "readlines", "write", "writelines", "close", "flush",
    "seek", "tell", "open", "connect", "login", "sendmail", "quit", "send",
    "recv", "bind", "listen", "accept", "get", "add", "discard", "union",
    "intersection", "difference",
  ],
  ast: {
    typeReferences: extractPythonTypeReferences,
  },
  calls: pythonCallHooks,
};
