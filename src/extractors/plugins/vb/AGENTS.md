# VB plugin

Reads Visual Basic — VB.NET (`.vb`), VB6 (`.bas`, `.cls`, `.frm`) and VBScript (`.vbs`) — through the regex path (`RegexLangSpec` in [index.ts](index.ts); no grammar). Family `dotnet`, so bare-name import resolution trusts C# candidates and the other way round. The .NET-wide pieces (UI bridge, NuGet, service config) live in [../csharp/AGENTS.md](../csharp/AGENTS.md); cross-language mechanisms in [../AGENTS.md](../AGENTS.md).

## Files and front end

- [manifest.ts](manifest.ts): extensions `.vb`, `.bas`, `.cls`, `.frm`, `.vbs`; `parsing: "regex"`; `family: "dotnet"`; `caseInsensitiveNames: true` (`_repo.save` calls the declared `Save`); `typesSpanFiles: true` (`Partial Class` splits one type across files); `packageEcosystems: ["nuget"]`; `projectMarkers` `**/*.vbproj` (kind `dotnet`, priority 30); generated files `*.Designer.vb`; `externalNamespaceRoots` `System`, `Microsoft`.
- `.cls` is VB6's: the Apex plugin takes an Apex class through the manifest's `adoptsSuffixes` (`.cls`, `*.object-meta.xml`, `*.field-meta.xml`) and the meta's `adopt`, so the registry's `preprocessFile` asks the adopting plugin before the owner's `preprocess` (in the analyzer and in discovery's skip check); no plugin imports another.
- `.vbs` is the VB6 dialect run statement by statement (cscript/wscript): the spec sets `topLevelCalls` for `.vbs` only (a path RegExp), so calls outside every function/class become the `<setup>` pseudo-function.
- A `CallPattern` anchored at a statement's start — VB's parenthesis-less `ProcessOrders conn` — sets `notAfter`, a regex the previous line (strings blanked, comment dropped) matches when it carries the statement on, so a continuation line (`b Then` under `If a AndAlso`) is never read as a call.
- Attributes sit on their own line above the declaration (possibly several, possibly with a ` _` continuation) or inline at the start of it (`<Attr>` lists, [index.ts](index.ts)); both are read. VB statements continue across lines (`_`, or implicitly inside an open argument list), so the DI reader works on LOGICAL statements with string contents and comments blanked.
- The manifest's `dispatchLanguages` of the C# plugin loads it for a VB project: a VB project loads csharp so the UI-bridge resolver runs (WinForms `Handles`-style and partial-class wiring join through the language-agnostic partial-class join).

## Structure and control flow

- Control flow ([control-flow.ts](control-flow.ts)): VB is a keyword-delimited language that goes through the shared regex scanner with a plugin `blockDelta` hook instead of brace counting. `blockDelta` says what each line opens (`If … Then` opens a block only when nothing follows its `Then`; a statement after it, `If x Then Exit Sub`, is a one-line guard), `blockClose` says what closes (`End If`, `Next`, `Loop`, `Wend`, `End While`, `End Select`, `End Try`), plus `inlineGuard` (`If c Then s`). Blocks: `If`/`End If`, `For`/`Next`, `Do`/`Loop`, `While`/`End While` (`Wend`), `Select Case`/`End Select`, `Try`/`End Try`, `With`, `Using`, `SyncLock`. Keywords are case-insensitive, so every pattern is too. The graph is marked `approximate`.
- Member effects: Visual Basic types found only in the writer's directory (`typesSpanFiles` without `typesBeyondDirectory`) are looked up as written.

## Routes and frameworks

- ASP.NET attribute routing in VB ([routes.ts](routes.ts)) is the same attribute layer the C# extractor reads (see [../csharp/AGENTS.md](../csharp/AGENTS.md)), spelled `<Route("api/users")> <ApiVersion("2")> <Authorize>`: class-level guards and versions are inherited by every action, an action's own `<Authorize>`/`<AllowAnonymous>` adds to or waives them, `<MapToApiVersion>` narrows the class's version set. A parameter binds where its `<FromX>` says; without one, a name the template declares comes from the route, a simple type from the query and a complex type from the body (Web API 2 and `[ApiController]` both bind that way for VB projects). Convention-routed `XxxController` classes without any attribute keep the Index/Get/Post/Put/Delete mapping.
- Request schemas ([request-schema.ts](request-schema.ts)): how VB.NET types and properties look on the wire under System.Text.Json / Newtonsoft, plus the attribute-text helpers the route extractor shares (`<Authorize(Roles:="Admin")>` is spelled the same on a class, method, parameter and property); `camelCase` (shared `inflection.ts`) is the JSON name .NET serializers give a property (C#, VB). Nothing there walks classes or routes — the core request-schema pass does.
- WinForms screens ([winforms-screens.ts](winforms-screens.ts)): `ScreenInfo` from designer code — `InitializeComponent()` (or any method that constructs controls): `Dim lblEmail As New Label With {.Text = "Email:", .Left = 20, …}`, `txtEmail = New TextBox With {…}`, `btnLogin.Text = "Login"`, `Me.Text = "Sign in"` and handler wiring `Private Sub btnLogin_Click(…) Handles btnLogin.Click`.

## API calls and data access

- [data-sources.ts](data-sources.ts) detects API call sites in VB.NET / VBA source: `_api.GetAsync(Of User)("/api/users")`, `_api.PostAsync(Of LoginResponse)("/api/auth/login", payload)`, `_http.GetAsync("https://example.com/foo")`, `Await client.PutAsync(Of T)($"/api/users/{id}", body)`; the `target` is the literal URL path so cross-repository route linking can match it against `RouteInfo.path`.

## Dependency injection

[di.ts](di.ts): container registrations (`services.AddScoped(Of IRepo, SqlRepo)()`, Autofac, Unity, Simple Injector), locals whose type the body states (`Dim r As New Repo()`, `Dim c = sp.GetRequiredService(Of IClock)()`) and container lookups chained straight into a call. The symbol linker joins them; nothing here decides which implementation an injection point receives.

## Reachability

[reachability.ts](reachability.ts) is the C# model's shape (a declarative spec built from `reachability-kit`, case-folded names): `Imports` names a namespace, types are reached by name, a program starts at `Program`/`Main` (`My Project`'s `Application.myapp` names the startup form), and what WinForms, ASP.NET or a test runner discovers is kept alive.

## Language server

The Docker LSP image is the .NET one: Roslyn `Microsoft.CodeAnalysis.LanguageServer` via the `misterkiem/roslyn-plusvb` fork that patches VB libraries into the upstream server; one container serves both `.cs` and `.vb`, and (like jdtls) its network is `"bridge"` because it restores packages to type-check (offline it loses most reference answers). Details in [../../../lsp/AGENTS.md](../../../lsp/AGENTS.md).
