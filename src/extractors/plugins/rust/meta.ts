import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rocketMountResolver } from "./rocket-mounts.js";
import { rustSpec } from "./index.js";
import { cargoPackages } from "./packages.js";
import { rustManifest } from "./manifest.js";
import { RustEntityExtractor } from "./entities.js";
import { rustRequestSchema } from "./request-schema.js";
import { rustReachability } from "./reachability.js";
import { AfDispatchResolver } from "./event-dispatch.js";
import { splitLines } from "../../shared/source-lines.js";
import { blankRustMultilineStrings, rustPathHeads } from "./source.js";
import { extractRustDataSources } from "./data-sources.js";

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
  // Rust: `loop`/`match`/`if let` are covered by the brace defaults; what it
  // adds is `?` as an exit and the lifetime tick, which is not a string quote.
  regexControlFlow: extendRegexControlFlow([], { quotes: ['"'] }),
  ...rustManifest,
  regexSpec: rustSpec,
  routeResolvers: [rocketMountResolver],
  // Multi-line strings are blanked so their code-shaped text is not read as
  // functions; the data sources (SQL in `r#"…"#`, URLs) come from the raw source.
  preprocess(rawSource) {
    const sourceText = blankRustMultilineStrings(rawSource);
    const blanked = sourceText !== rawSource;
    return {
      sourceText,
      language: "rust",
      postExtract(analysis, raw) {
        if (blanked) analysis.dataSources = extractRustDataSources(splitLines(raw));
        const refs = rustPathHeads(sourceText, analysis.imports);
        if (refs.length > 0) analysis.packageReferences = refs;
      },
    };
  },
  // AppFlowy lib-dispatch: a Flutter call of a generated event class runs the Rust handler (event-dispatch.ts).
  dispatchResolvers: [new AfDispatchResolver()],
  dispatchLanguages: ["dart"],
  builtinTypes: RUST_BUILTINS,
  // Auto-deref: `self.repo.find()` on a `repo: Arc<dyn UserRepo>` calls the
  // trait's `find`. `RefCell`/`Mutex` are not listed — their calls go through
  // `.borrow()` / `.lock()` first.
  transparentTypeWrappers: ["Arc", "Box", "Rc", "Cow"],
  knownPackages: cargoPackages,
  entities: new RustEntityExtractor(),
  requestSchema: rustRequestSchema,
  reachability: rustReachability,
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
