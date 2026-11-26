# Blazor plugin

Reads `.razor` component markup through the regex path ([index.ts](index.ts), `RegexLangSpec`); family `dotnet`, not an import target (`importTarget: false`). It is the UI-markup half only: the component's C# lives in a `@code { }` block or, in component libraries and desktop tools, a sibling `Foo.razor.cs` code-behind partial class owned by the C# plugin ([../csharp/AGENTS.md](../csharp/AGENTS.md)).

## Files

- [index.ts](index.ts) — markup extraction (routes from `@page`, imports, sub-components, interactive elements, layout `@Body`, `linksFromBase`); its header comment holds the rules.
- [data-sources.ts](data-sources.ts) — `HttpClient` calls, receiver-gated.
- [reachability.ts](reachability.ts) — declarative spec read with the C# model (case-folded names).
- [manifest.ts](manifest.ts), [meta.ts](meta.ts) — static and runtime tiers (`routerOutlet: /@Body\b/`).

## Rules

- Never extract components, methods or `@code` C# here: the code-behind owns them and re-declaring the partial class would collide (one exception, a component whose markup states its type, is in the header).
- Handlers (`@onclick="Save"`) are joined to the class method by the C# plugin's UI bridge, INFERRED by class name.
- A screen is the sum of what makes it up: components it renders, its code-behind class, `codeFiles` and the `viewModel` it binds.
