# Blazor plugin

Reads `.razor` component markup through the regex path ([index.ts](index.ts), `RegexLangSpec`); family `dotnet`, not an import target (`importTarget: false`). It is the UI-markup half only: the component's C# lives in a `@code { }` block or, in component libraries and desktop tools, a sibling `Foo.razor.cs` code-behind partial class owned by the C# plugin ([../csharp/AGENTS.md](../csharp/AGENTS.md)).

## Markup extraction

- `@page "/route"` is a frontend route (and so a routed screen); `{id:int}` tokens are route params, typed by the constraint, else by a same-named `[Parameter]` property; `[SupplyParameterFromQuery]` properties are query params; `@attribute [Authorize(…)]` / `[AllowAnonymous]` are the page's `auth` (read as the C# plugin reads them).
- `@using X.Y` is an import (namespace dependency + framework hint: `Microsoft.AspNetCore.Components` → `blazor`). PascalCase tags (`<Button …>`) are sub-components (the composition graph); `@onclick` / `@bind` / native events are interactive elements.
- Components, methods and `@code` C# are NOT extracted here — the code-behind owns them and re-declaring the partial class would collide. The one exception is a component whose markup states its type (`@inherits ClubPageBase`, `@implements IDisposable`): it is declared as a class named after the file, so a handler the base class declares links. `@code` blocks and `@* … *@` comments are blanked before the markup scan so C# generics (`Dictionary<String, …>`) never read as component tags.
- Handlers: `@onclick="Save"` names a method of the component class, a partial whose code sits in `Garage.razor.cs` when the markup's own `@code` block does not declare it; the C# plugin's UI bridge joins it (INFERRED, by class name).

## Screens and navigation

- A layout renders the routed page where it writes `@Body` (manifest `routerOutlet: /@Body\b/`); core hangs the routed page off that component as a `shell` node.
- `linksFromBase: true`: `<base href="/">` makes `href="cart"` and `Nav.NavigateTo("user/orders")` app-root paths.
- A screen is the sum of what makes it up: components it renders (by import, or by name — Blazor's namespace components — in its own sub-project or one it uses), its code-behind class, `codeFiles` and the `viewModel` it binds.

## API calls

[data-sources.ts](data-sources.ts): HTTP calls a component makes through an injected `HttpClient` (`@inject HttpClient Http`; `await Http.PostAsync($"/api/clubs/{Name}/promote", null)`, `Http.GetFromJsonAsync<List<Club>>("api/clubs")`). Only a receiver the file declares as an `HttpClient` (an `@inject`, an `[Inject]` property or a field) counts — `Repo.GetAsync("x")` is somebody else's method; a URL that is not a literal (a variable, a concatenation) states no path and gives no row.

## Scope and reachability

- The Blazor WebAssembly SDK's implicit global usings are only Configuration, DependencyInjection and Logging (applied by the C# plugin's `projectFileUsings`).
- [reachability.ts](reachability.ts): a component is its file name used as a tag (`<Counter />`, a name reference); a component with `@page` is routed by the framework; the code-behind partial class is C#, reached by the same name. Blazor is a declarative reachability spec (case-folded names), so dead code reads it with the C# model.
