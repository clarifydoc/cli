import type { Language } from "../../types/analysis.js";

/**
 * Per-language deny-lists of identifiers that should NOT be tracked as
 * project type references. These are primitives, common stdlib collection
 * types, and language-specific keywords that would otherwise flood the
 * data-model blast view with noise.
 *
 * The lists are intentionally conservative — when in doubt about a name, we
 * keep it (better to track a stdlib type once than to miss a project type
 * that happens to share a stdlib name).
 */

const COMMON_PRIMITIVES = new Set<string>([
  "string", "String", "str",
  "number", "Number", "int", "long", "short", "byte",
  "float", "double", "decimal", "real", "single",
  "bool", "Bool", "boolean", "Boolean",
  "void", "Void", "Unit", "Nothing",
  "any", "Any", "unknown", "object", "Object",
  "null", "undefined", "None", "nil", "nullptr",
  "this", "Self", "self",
]);

const TS_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Array", "ReadonlyArray", "Map", "Set", "WeakMap", "WeakSet",
  "Promise", "PromiseLike", "Awaited",
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract",
  "NonNullable", "ReturnType", "InstanceType", "Parameters", "Awaited",
  "Date", "RegExp", "Error", "Function",
  "Symbol", "BigInt", "Iterable", "Iterator", "AsyncIterable", "AsyncIterator",
  "Generator", "AsyncGenerator",
  "Buffer", "ArrayBuffer", "Uint8Array", "Int32Array", "Float64Array",
  // React common types
  "ReactNode", "ReactElement", "JSX", "FC", "FunctionComponent",
  "Element", "Component", "PropsWithChildren",
  // DOM
  "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Node",
  "Event", "MouseEvent", "KeyboardEvent",
]);

const JAVA_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "var", "T", "E", "K", "V",
  "Integer", "Long", "Short", "Byte", "Float", "Double", "Character", "Boolean",
  "List", "ArrayList", "LinkedList",
  "Map", "HashMap", "TreeMap", "LinkedHashMap",
  "Set", "HashSet", "TreeSet", "LinkedHashSet",
  "Collection", "Iterable", "Iterator", "Stream", "Optional",
  "String", "StringBuilder", "StringBuffer",
  "Exception", "RuntimeException", "Throwable", "Error",
  "Object", "Class", "Comparable", "Comparator",
  "Date", "LocalDate", "LocalDateTime", "Instant", "Duration",
  // Spring framework common
  "ResponseEntity", "RequestEntity", "HttpStatus",
]);

const CSHARP_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int16", "Int32", "Int64", "UInt16", "UInt32", "UInt64",
  "Single", "Double", "Decimal",
  "List", "Dictionary", "HashSet", "Queue", "Stack",
  "IEnumerable", "ICollection", "IList", "IDictionary", "ISet",
  "Task", "ValueTask", "Action", "Func",
  "String", "StringBuilder",
  "DateTime", "DateTimeOffset", "TimeSpan", "Guid",
  "Exception", "ArgumentException", "InvalidOperationException",
  "Tuple", "ValueTuple", "Nullable",
  // ASP.NET common
  "IActionResult", "ActionResult", "IServiceCollection",
]);

const PYTHON_BUILTINS = new Set<string>([
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

const KOTLIN_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Long", "Short", "Byte", "Float", "Double", "Char",
  "List", "MutableList", "Set", "MutableSet", "Map", "MutableMap",
  "Array", "IntArray", "LongArray", "ByteArray",
  "String", "CharSequence", "Sequence",
  "Pair", "Triple", "Result",
  "Unit", "Throwable", "Exception", "Any", "Nothing",
  "Iterable", "Iterator", "Collection",
]);

const PASCAL_BUILTINS = new Set<string>([
  "Integer", "Cardinal", "Word", "Byte", "ShortInt", "SmallInt", "LongInt",
  "Int64", "QWord",
  "Real", "Single", "Double", "Extended", "Currency",
  "Boolean", "ByteBool", "WordBool", "LongBool",
  "Char", "WideChar", "AnsiChar",
  "String", "AnsiString", "WideString", "UnicodeString", "ShortString", "RawByteString",
  "Pointer", "TObject", "TClass",
  "Variant", "OleVariant",
  "PChar", "PAnsiChar", "PWideChar",
  // Common VCL/RTL
  "TStream", "TStringList", "TStrings", "TList", "TDateTime", "Exception",
]);

const GO_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "float32", "float64", "complex64", "complex128",
  "byte", "rune", "string", "bool", "error",
  "any", "comparable",
  "map", "chan", "interface",
]);

const RUST_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "i8", "i16", "i32", "i64", "i128", "isize",
  "u8", "u16", "u32", "u64", "u128", "usize",
  "f32", "f64", "bool", "char", "str",
  "String", "Vec", "Box", "Rc", "Arc", "Cell", "RefCell", "Mutex", "RwLock",
  "Option", "Result", "Some", "None", "Ok", "Err",
  "HashMap", "BTreeMap", "HashSet", "BTreeSet",
  "Iterator", "IntoIterator", "Future",
  "Send", "Sync", "Sized", "Copy", "Clone", "Debug", "Display",
  "dyn", "impl",
]);

const PHP_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "float", "bool", "string", "array", "iterable", "callable",
  "mixed", "never", "false", "true",
  "self", "static", "parent",
  "Exception", "Throwable", "Error", "TypeError",
  "stdClass", "Closure", "Generator", "Traversable",
  "ArrayAccess", "Countable", "Iterator", "IteratorAggregate",
]);

const SWIFT_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Int8", "Int16", "Int32", "Int64",
  "UInt", "UInt8", "UInt16", "UInt32", "UInt64",
  "Float", "Double", "Bool", "Character",
  "String", "Substring",
  "Array", "Set", "Dictionary",
  "Optional", "Result",
  "Error", "Any", "AnyObject",
  "Void",
]);

const SCALA_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Long", "Short", "Byte", "Float", "Double", "Boolean", "Char",
  "List", "Seq", "Vector", "Array", "Map", "Set", "Option", "Some", "None",
  "Either", "Left", "Right", "Try", "Success", "Failure",
  "Future", "Promise",
  "String", "AnyVal", "AnyRef", "Nothing", "Unit",
]);

const VB_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Integer", "Long", "Short", "Byte", "SByte",
  "Single", "Double", "Decimal",
  "Boolean", "Char", "String", "Date", "DateTime",
  "Object", "Nothing",
  "List", "Dictionary", "ArrayList",
  "Exception", "Variant",
]);

const C_BUILTINS = new Set<string>([
  ...COMMON_PRIMITIVES,
  "char", "signed", "unsigned", "size_t", "ssize_t", "ptrdiff_t",
  "int8_t", "int16_t", "int32_t", "int64_t",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "intptr_t", "uintptr_t", "FILE", "NULL",
]);

const CPP_BUILTINS = new Set<string>([
  ...C_BUILTINS,
  "wchar_t", "char16_t", "char32_t",
  "std", "string", "wstring", "string_view",
  "vector", "array", "list", "deque", "forward_list",
  "map", "unordered_map", "set", "unordered_set", "multimap", "multiset",
  "pair", "tuple", "optional", "variant", "any",
  "shared_ptr", "unique_ptr", "weak_ptr",
  "function", "thread", "mutex", "future", "promise",
  "exception", "runtime_error", "logic_error",
  "iostream", "ostream", "istream", "stringstream",
]);

const RUBY_BUILTINS = new Set<string>(COMMON_PRIMITIVES);
const LUA_BUILTINS = new Set<string>(COMMON_PRIMITIVES);
const PERL_BUILTINS = new Set<string>(COMMON_PRIMITIVES);

const DENY_BY_LANGUAGE: Record<Language, ReadonlySet<string>> = {
  typescript: TS_BUILTINS,
  javascript: TS_BUILTINS,
  java: JAVA_BUILTINS,
  kotlin: KOTLIN_BUILTINS,
  csharp: CSHARP_BUILTINS,
  python: PYTHON_BUILTINS,
  pascal: PASCAL_BUILTINS,
  dfm: PASCAL_BUILTINS,
  go: GO_BUILTINS,
  rust: RUST_BUILTINS,
  ruby: RUBY_BUILTINS,
  php: PHP_BUILTINS,
  swift: SWIFT_BUILTINS,
  lua: LUA_BUILTINS,
  scala: SCALA_BUILTINS,
  perl: PERL_BUILTINS,
  vb: VB_BUILTINS,
  sql: new Set<string>(COMMON_PRIMITIVES),
  c: C_BUILTINS,
  cpp: CPP_BUILTINS,
};

/** Return true if the identifier is a built-in / stdlib type for the language. */
export function isBuiltinType(typeName: string, language: Language): boolean {
  const deny = DENY_BY_LANGUAGE[language];
  return deny ? deny.has(typeName) : false;
}
