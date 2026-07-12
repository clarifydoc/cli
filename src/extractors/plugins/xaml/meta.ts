import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { xamlSpec } from "./index.js";

/**
 * XAML UI markup (WPF / Avalonia / MAUI / WinUI). Screens + interactive
 * elements + sub-components only; the behaviour lives in the code-behind
 * partial class (`<same path>.cs`), parsed by the csharp plugin and joined by
 * CsharpUiBridgeResolver.
 */
export const xamlMeta: LanguagePluginMeta = {
  language: "xaml",
  parsing: "regex",
  extensions: xamlSpec.extensions,
  regexSpec: xamlSpec,
  // Markup is never an import target; the code-behind shares its basename
  // (`MainWindow.axaml` / `MainWindow.axaml.cs`), so keeping .xaml out of the
  // import path map avoids collisions (mirrors the qtui/dfm handling).
  importTarget: false,
};
