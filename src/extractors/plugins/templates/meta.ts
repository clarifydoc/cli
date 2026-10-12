import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { readTemplate, templateSpec, type TemplateDialect } from "./index.js";
import { handlebarsManifest, liquidManifest, razorManifest, velocityManifest } from "./manifest.js";
import { RazorTargetResolver } from "./razor-target-resolver.js";

/** Server templates: their screens, partials, forms and links (see index.ts). */
const templateMeta = (manifest: typeof handlebarsManifest, dialect: TemplateDialect): LanguagePluginMeta => ({
  ...manifest,
  regexSpec: templateSpec(dialect, [...manifest.extensions]),
  preprocess: (rawSource) => ({ sourceText: rawSource, language: dialect, postExtract: (analysis, raw) => readTemplate(analysis, raw, dialect) }),
});

export const handlebarsMeta = templateMeta(handlebarsManifest, "handlebars");
export const liquidMeta = templateMeta(liquidManifest, "liquid");
export const velocityMeta = templateMeta(velocityManifest, "velocity");
export const razorMeta: LanguagePluginMeta = { ...templateMeta(razorManifest, "razor"), dispatchResolvers: [new RazorTargetResolver()] };
