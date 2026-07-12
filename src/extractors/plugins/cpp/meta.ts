import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { cppSpec } from "./index.js";
import { nativePackages } from "./packages.js";
import { C_BUILTINS } from "../c/meta.js";
import { cppManifest } from "./manifest.js";

const CPP_BUILTINS: ReadonlySet<string> = new Set<string>([
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

export const cppMeta: LanguagePluginMeta = {
  ...cppManifest,
  regexSpec: cppSpec,
  knownPackages: nativePackages,
  builtinTypes: CPP_BUILTINS,
};
