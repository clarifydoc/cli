import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { erbSpec, extractErbView } from "./index.js";
import { erbManifest } from "./manifest.js";
import { RailsViewResolver } from "./rails-view-resolver.js";

/**
 * Rails ERB views: the screens of a server-rendered Rails app — its forms,
 * buttons, links and partials — joined to the controller actions they reach
 * by `RailsViewResolver`. The Ruby inside the tags is read for what it renders
 * and requests, not analyzed as code.
 */
export const erbMeta: LanguagePluginMeta = {
  ...erbManifest,
  regexSpec: erbSpec,
  preprocess: (rawSource) => ({ sourceText: rawSource, language: "erb", postExtract: (analysis, raw) => extractErbView(analysis, raw) }),
  dispatchResolvers: [new RailsViewResolver()],
};
