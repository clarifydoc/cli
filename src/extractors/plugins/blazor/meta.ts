import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { blazorSpec } from "./index.js";
import { blazorManifest } from "./manifest.js";
import { blazorReachability } from "./reachability.js";

/**
 * Blazor `.razor` markup. The component's C# logic is parsed elsewhere (a
 * `@code` block is C#, and most components keep their code in a sibling
 * `Foo.razor.cs` code-behind owned by the C# plugin), so this plugin is the
 * UI-markup half: component usage, interactive elements, `@page` routes.
 */
export const blazorMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: blazorReachability,
  ...blazorManifest,
  regexSpec: blazorSpec,
};
