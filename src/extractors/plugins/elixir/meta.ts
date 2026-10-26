import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { elixirSpec } from "./index.js";
import { hexPackages } from "./packages.js";
import { elixirManifest } from "./manifest.js";
import { elixirRequestSchema } from "./request-schema.js";
import { elixirReachability } from "./reachability.js";
import { PhoenixEventResolver } from "./phoenix-event-resolver.js";
import { ELIXIR_REGEX_CONTROL_FLOW } from "./control-flow.js";
import { ElixirEntityExtractor } from "./entities.js";

const ELIXIR_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Enum", "Map", "List", "String", "Integer", "Float", "Atom", "Tuple",
  "Keyword", "Range", "Stream", "MapSet", "Process", "Agent", "Task",
  "GenServer", "Supervisor", "Application", "Logger", "Kernel", "IO",
  "File", "Path", "Regex", "Date", "DateTime", "NaiveDateTime", "Time",
]);

export const elixirMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: elixirReachability,
  ...elixirManifest,
  regexSpec: elixirSpec,
  // Project-level: `Repo.preload(:assoc)` rows typed by the schemas declaring the association.
  entities: new ElixirEntityExtractor(),
  // Control flow from source: keyword-delimited blocks (see control-flow.ts).
  regexControlFlow: ELIXIR_REGEX_CONTROL_FLOW,
  builtinTypes: ELIXIR_BUILTINS,
  knownPackages: hexPackages,
  apiCallRoots: ["HTTPoison", "Tesla", "Finch", "Req", "Mint"],
  dbCallRoots: ["Repo"],
  requestSchema: elixirRequestSchema,
  dispatchResolvers: [new PhoenixEventResolver()],
  dispatchLanguages: ["heex"],
};
