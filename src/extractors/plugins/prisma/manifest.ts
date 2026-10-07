import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { prismaFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const prismaManifest: LanguagePluginManifest = {
  language: "prisma",
  parsing: "regex",
  extensions: [".prisma"],
  importTarget: false,
  frameworkRules: prismaFrameworkRules,
};
