import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { elixirSpec } from "./index.js";
import { hexPackages } from "./packages.js";

const ELIXIR_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Enum", "Map", "List", "String", "Integer", "Float", "Atom", "Tuple",
  "Keyword", "Range", "Stream", "MapSet", "Process", "Agent", "Task",
  "GenServer", "Supervisor", "Application", "Logger", "Kernel", "IO",
  "File", "Path", "Regex", "Date", "DateTime", "NaiveDateTime", "Time",
]);

export const elixirMeta: LanguagePluginMeta = {
  language: "elixir",
  parsing: "regex",
  extensions: elixirSpec.extensions,
  regexSpec: elixirSpec,
  // ExUnit test files use the `.exs` script extension: `foo_test.exs`.
  testFilePatterns: [/_test\.exs$/],
  builtinTypes: ELIXIR_BUILTINS,
  knownPackages: hexPackages,
  externalModulePrefixes: [
    "Enum", "Map", "List", "String", "Kernel", "IO", "File", "Path", "Logger",
    "GenServer", "Supervisor", "Application", "Process", "Agent", "Task", "Stream",
    "Ecto", "Phoenix", "Plug", "Jason",
  ],
  frameworkImportHints: {
    "Phoenix": "phoenix",
    "Phoenix.Controller": "phoenix",
    "Phoenix.Router": "phoenix",
    "Phoenix.LiveView": "phoenix_live_view",
    "Ecto": "ecto",
    "Ecto.Schema": "ecto",
    "Plug": "plug",
    "Absinthe": "absinthe",
  },
  apiCallRoots: ["HTTPoison", "Tesla", "Finch", "Req", "Mint"],
  dbCallRoots: ["Repo"],
};
