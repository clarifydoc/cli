import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";

/**
 * BCL / framework type names that are never project classes. Its own module
 * so the call hooks (receiver typing) can share it with the meta without an
 * import cycle.
 */
export const CSHARP_BUILTINS: ReadonlySet<string> = new Set<string>([
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
