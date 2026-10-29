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

/**
 * A Phoenix controller renders its templates by convention: `render(conn, :show)` (or `"show.html"`)
 * in `controllers/club_controller.ex` is `controllers/club_html/show.html.heex` (Phoenix 1.7's
 * `embed_templates`), else `templates/club/show.html.(h)eex` beside `controllers/` (Phoenix 1.6).
 */
function phoenixTemplatePaths(name: string, fromFile?: string): string[] {
  const m = fromFile ? /^(.*\/)controllers\/(?:.*\/)?(\w+)_controller\.ex$/.exec(fromFile) : null;
  if (!m || !/^[\w-]+(?:\.html)?$/.test(name)) return [];
  const [, web, controller] = m;
  const view = name.replace(/\.html$/, "");
  const dir = fromFile!.slice(0, fromFile!.lastIndexOf("/") + 1);
  return ["heex", "eex"].flatMap((ext) => [`${dir}${controller}_html/${view}.html.${ext}`, `${web}templates/${controller}/${view}.html.${ext}`]);
}

export const elixirMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: elixirReachability,
  templatePaths: phoenixTemplatePaths,
  ...elixirManifest,
  regexSpec: elixirSpec,
  // Functions and calls read by tree-sitter-elixir while the `tree-sitter:elixir` feature is on (tree-sitter.ts).
  treeSitter: { grammar: "elixir", load: () => import("./tree-sitter.js").then((m) => m.loadElixirReader()) },
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
