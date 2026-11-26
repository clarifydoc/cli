# XAML plugin

Reads XAML UI markup — WPF `.xaml`, Avalonia `.axaml`, and the MAUI/WinUI dialects, which share the tag/attribute grammar — through the regex path ([index.ts](index.ts)); family `dotnet`, not an import target. Screens, interactive elements and sub-components only: behaviour lives in the code-behind partial class (`<same path>.cs`), parsed by the C# plugin ([../csharp/AGENTS.md](../csharp/AGENTS.md)) and joined by `CsharpUiBridgeResolver`.

- [index.ts](index.ts) — the `RegexLangSpec`; its header comment holds the tag tokenizer, the x:Class/handler bridge and MAUI Shell routing rules. [manifest.ts](manifest.ts) / [meta.ts](meta.ts) — static and runtime tiers (`routerOutlet: /<Shell[\s>]/`).
- Rule: tags span many lines, so extraction runs on a tag tokenizer, never line regexes.
- The C# manifest lists `xaml` and `vb` in `dispatchLanguages`, so a project holding only XAML and VB still loads the C# resolver.
