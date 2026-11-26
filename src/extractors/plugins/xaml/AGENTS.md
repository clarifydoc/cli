# XAML plugin

Reads XAML UI markup — WPF `.xaml`, Avalonia `.axaml`, and the MAUI/WinUI dialects, which share the tag/attribute grammar — through the regex path ([index.ts](index.ts)); family `dotnet`, not an import target. Screens, interactive elements and sub-components only: behaviour lives in the code-behind partial class (`<same path>.cs`), parsed by the C# plugin ([../csharp/AGENTS.md](../csharp/AGENTS.md)) and joined by `CsharpUiBridgeResolver`.

- Each file is one window/control: `x:Class="Ns.MainWindow"` names the code-behind class, nested elements are the component tree, event attributes (`Click="ButtonCopy_Click"`) wire controls to code-behind methods. The handler lives in `<same path>.cs`, so the elements alone dead-end; the bridge adds the synthetic element → handler symbol links (INFERRED, joined by class name, the candidate whose path shares the longest prefix with the UI file winning).
- XAML opening tags routinely span many lines (one attribute per line), unlike Qt Designer `.ui` XML, so extraction runs on a tag TOKENIZER over the whole text, not on line regexes.
- MAUI Shell: `<Shell>` is the frame its tabs and flyout pages show in (manifest `routerOutlet: /<Shell[\s>]/`), a start `shell` node in the navigation map. MAUI routes: `<ShellContent Route>` under `<TabBar Route>` in XAML, `Routing.RegisterRoute` in C#; `GoToAsync("Basket")` names an app-root path (the C# plugin's `linksFromBase`).
- The C# manifest lists `xaml` and `vb` in `dispatchLanguages`, so a project holding only XAML and VB still loads the C# resolver.
