import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rustSpec } from "./index.js";
import { cargoPackages } from "./packages.js";
import { rustManifest } from "./manifest.js";
import { RustEntityExtractor } from "./entities.js";

const RUST_BUILTINS: ReadonlySet<string> = new Set<string>([
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

export const rustMeta: LanguagePluginMeta = {
  ...rustManifest,
  regexSpec: rustSpec,
  builtinTypes: RUST_BUILTINS,
  knownPackages: cargoPackages,
  entities: new RustEntityExtractor(),
  complexity: {
    branchNodes: new Set([
      "if_expression", "while_expression", "for_expression", "loop_expression",
      "match_arm", "if_let_expression",
    ]),
    logicalOps: new Set(["&&", "||"]),
  },
  // Call node types for when a tree-sitter grammar is wired up.
  calls: { callNodeTypes: new Set(["call_expression", "macro_invocation"]) },
};
