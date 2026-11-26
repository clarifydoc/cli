import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { firstBranchView } from "../shared/preprocessor-branches.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { cppSpec } from "./index.js";
import { nativePackages } from "./packages.js";
import { C_BUILTINS } from "../c/meta.js";
import { cppManifest } from "./manifest.js";
import { cppOverloadTypeKey } from "./arg-kinds.js";
import { cFamilyReachability } from "../shared/c-family-reachability.js";
import { cppGrpcService } from "../shared/grpc-stubs.js";
import { isObjcHeader } from "../shared/objc-header.js";

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
  // `.h` has one owner; an Objective-C header (`@interface`, a framework import) is read as Objective-C.
  preprocess: (rawSource, relativePath) => (isObjcHeader(relativePath, rawSource) ? { sourceText: rawSource, language: "objc" } : null),
  // Dead-code reachability (see c-family-reachability.ts).
  reachability: cFamilyReachability,
  regexControlFlow: extendRegexControlFlow([{ match: /^goto\b/, type: "break_statement" }], { sourceView: (text) => firstBranchView(text, true) }),
  ...cppManifest,
  regexSpec: cppSpec,
  antlr: { grammar: "cpp", load: () => import("./antlr.js").then((m) => m.readCpp) },
  knownPackages: nativePackages,
  builtinTypes: CPP_BUILTINS,
  // Owning pointers a member call goes through (`coach_->drill()` on a `std::unique_ptr<Coach>`). `weak_ptr` is
  // not one: its value is reached through `lock()`.
  transparentTypeWrappers: ["unique_ptr", "shared_ptr", "QSharedPointer", "QScopedPointer", "QPointer", "scoped_refptr", "intrusive_ptr", "ComPtr", "CComPtr", "not_null", "observer_ptr"],
  grpcServiceOf: cppGrpcService,
  // `class Paddock { class Iterator … }` is `Paddock::Iterator` (see classes.ts).
  nestedTypePaths: true,
  // Overloads: `conversionRanks` makes core rank exact > promotion > conversion (`argFit`'s `ranked` scale);
  // `explicitSpecializations` has `convert<int>(x)` choose the definition whose `FunctionInfo.specializedOn` names those
  // arguments. An argument naming a variable is `@name` (also `*name`, `this->name`); core types it from the parameters,
  // typed locals, `auto c = Club(3)` and the class's fields, and `pickOverloads` reads a call's site from the link's own
  // file only.
  // The parse states each call's argument count and kinds (`CallInfo.argCount`/`argKinds`); the linker chooses among
  // same-named definitions by them. No tree-sitter reading, so no call node types.
  calls: { callNodeTypes: new Set<string>(), overloadTypeKey: cppOverloadTypeKey, conversionRanks: true, explicitSpecializations: true },
};
