import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { xamlSpec } from "./index.js";
import { xamlManifest } from "./manifest.js";

/**
 * XAML UI markup (WPF / Avalonia / MAUI / WinUI). Screens + interactive
 * elements + sub-components only; the behaviour lives in the code-behind
 * partial class (`<same path>.cs`), parsed by the csharp plugin and joined by
 * CsharpUiBridgeResolver.
 */
export const xamlMeta: LanguagePluginMeta = {
  ...xamlManifest,
  regexSpec: xamlSpec,
};
