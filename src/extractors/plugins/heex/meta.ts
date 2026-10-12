import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { heexSpec } from "./index.js";
import { heexManifest } from "./manifest.js";

/**
 * Phoenix templates: their screens, `phx-*` events, links and forms. The
 * joins to LiveView `handle_event` clauses and controller actions are the
 * Elixir plugin's `PhoenixEventResolver` (it also reads inline `~H` sigils).
 */
export const heexMeta: LanguagePluginMeta = {
  ...heexManifest,
  regexSpec: heexSpec,
};
