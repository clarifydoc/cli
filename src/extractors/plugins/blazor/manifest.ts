import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const blazorManifest: LanguagePluginManifest = {
  language: "blazor",
  family: "dotnet",
  parsing: "regex",
  extensions: [".razor"],
  importTarget: false,
  frameworkImportHints: { "Microsoft.AspNetCore.Components": "blazor" },
  // A layout renders the routed page where it writes `@Body`.
  routerOutlet: /@Body\b/,
  // `<base href="/">`: `href="cart"`, `Nav.NavigateTo("user/orders")` are app-root paths.
  linksFromBase: true,
};
