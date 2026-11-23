import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { sfmarkupResolvers } from "./resolver.js";
import { sfmarkupSource } from "./preprocess.js";
import { sfmarkupSpec } from "./index.js";
import { sfmarkupManifest } from "./manifest.js";

/**
 * Salesforce's server-side and Aura markup: an Aura component (`aura/clubList/clubList.cmp`, `controller="ClubController"`)
 * and a Visualforce page or component (`<apex:page controller="ClubController" extensions="ClubExtension">`). Screens,
 * the handlers the markup names (`{!c.handleSave}`, `action="{!save}"`) and what a Visualforce page reads (`{!clubs}`);
 * the behaviour is in the Aura script files (the JS plugin) and the Apex classes (the Apex plugin), joined by the resolver.
 */
export const sfmarkupMeta: LanguagePluginMeta = {
  ...sfmarkupManifest,
  regexSpec: sfmarkupSpec,
  preprocess: sfmarkupSource,
  dispatchResolvers: sfmarkupResolvers,
};
