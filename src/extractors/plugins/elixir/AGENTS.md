# Elixir plugin

Reads `.ex` / `.exs` through a regex `RegexLangSpec` ([index.ts](index.ts)) with a tree-sitter front end (`meta.treeSitter`, [tree-sitter.ts](tree-sitter.ts); `parsing` stays `"regex"`, feature `tree-sitter`, off with `no-tree-sitter:elixir`) supplying functions and calls; a file with syntax errors keeps the regex reading. The grammar reads a HEEx `~H` sigil as text, so the front end reads that markup line by line (details in [parsers/AGENTS.md](../../../parsers/AGENTS.md)). The `heex` plugin (last section) is documented here.

## Modules, imports and naming

- A module is named whole: the manifest's `wholeTypeNames` makes core's lookup never fall back to the last segment, so a thrown or referenced `File.Error` is never a project module `Error`. A module reference through the file's `alias` lines (`alias MyApp.Accounts.User`, a shortened `User.changeset`) expands to the declared name; a module import or dotted call names a module by its DECLARED name.
- `import Club` puts the module's members in scope by bare name (`ImportInfo.inScope`); `import Club, except: [kick: 1]` keeps the excluded names out (`ImportInfo.inScope.except`), and `defdelegate [pass: 1, kick: 1], to: Club` forwards. Family `elixir` (HEEx shares it).
- Hex packages: `mix.exs` dependency tuples ([package-manifests.ts](package-manifests.ts)); Erlang's rebar3 contributes `rebar.config` to the same `hex` ecosystem (only one plugin defines the matching). Doc comments: `@doc """` is a `blockLead` block.
- Member effects ([member-effects.ts](member-effects.ts)): `raise` names a module through the file's `alias` lines; Elixir states no field writes.
- Dead code ([reachability.ts](reachability.ts)): every module under `lib/` is compiled and used through its NAME (`alias`, `User.changeset`), so a module nothing mentions is dead (reached by name, `declaredNames`). A program starts at the OTP application `mix.exs` names (`mod: {MyApp.Application, []}`) or an escript's `main_module`; `mix.exs` is only the project file; a library (a Hex package with no `mod:`) starts nothing and is not judged.
- Control flow: keyword-delimited, regex scanner with a `blockDelta` hook ([control-flow.ts](control-flow.ts)), approximate.
- Client bases: Elixir (`config/*.exs`) states no `serviceConfig` base yet (runtime-chosen endpoints).

## Phoenix routes, controllers and schemas ([phoenix.ts](phoenix.ts))

- The router is where auth lives (`pipeline :auth do plug … end` + `pipe_through [:api, :auth]` per scope); the controller is where the request is read (`def show(conn, %{"id" => id})`); an Ecto `schema` block is the only typed shape a body has.
- A route names its handler `Class.method` (a namespaced `MyAppWeb.UserController` counts): the linker binds it only to that class's method, never by name alone to a same-named method of another class; an action the class lacks stays unresolved.
- Ecto: schemas are read per file by the regex spec (`schema` blocks, association macros); [entities.ts](entities.ts) adds the project-level join — a `Repo.preload(:team)` row names an association, and the schema it loads is whatever the project's schemas declare under that association name (`belongs_to :team, League.Team`); the row is typed only when every schema declaring the name agrees on the target, else it stays a read of unknown entity. [request-schema.ts](request-schema.ts): Ecto field types as Jason/Poison serialize them (`field :age, :integer`, `{:array, :string}`, `Ecto.Enum`, an embedded schema module); the language-agnostic request-schema pass owns the recursion.
- **Channels** ([channels.ts](channels.ts)): Phoenix Channels as message channels named by event, scoped by joined topic (`scopeChannelTopics`, `core/channel-topics.ts`); rules in that file.
- Screens (consumed by core's navigation pass): `~p"…"` in `href=`/`navigate=`/`patch=`, `push_navigate`/`redirect(…, to: ~p"…")` and `#{…}` as a parameter are links; a `live` route's component is its module under the scope aliases, matched to the screen of that module name; controller templates by convention through the plugin's `templatePaths(name, fromFile)` (`render(conn, :show)` → `club_html/show.html.heex`), atom view names read by rendered-views.

## Markup → server code ([phoenix-event-resolver.ts](phoenix-event-resolver.ts), `PhoenixEventResolver`)

Two joins, both from what the markup states, each linking the markup's handler symbol to the server function:

- A `phx-*="event"` element → the `handle_event("event")` clause of the LiveView (or LiveComponent) that renders it: the module whose lines hold an inline `~H` element, or for a co-located template (`settings_live.html.heex`) the module in `settings_live.ex`. Where that module has none and the markup names no `phx-target` (`InteractiveElementInfo.targeted`, set by the HEEx reader for any `phx-target`), the event goes to each module that renders it (`<.live_component module={Mod}>`, by full name or the name the rendering file's `alias` shortens it to — `extractSubComponents` reads `~H` sigils for them) and declares that clause, as Phoenix sends the event to the LiveView process. A renderer without the clause links nothing; a targeted event never falls back. Function components rendered by name (`<.filter_bar>`) are not followed.
- A link or form `request` (literal path, interpolations as `:param`) → the Phoenix route serving that path and verb, then the controller action (`SiteController.settings`; the route names its controller relative to the scope alias, so the module is the ONE whose name ends so).

## Tests and commands

[test-command.ts](test-command.ts) and [project-commands.ts](project-commands.ts): `mix test file[:line]`; an umbrella app's tests run inside the app (`(cd apps/<app> && mix test …)`).

## HEEx (`../heex/`, a section of Elixir)

Regex plugin for `.heex`, `.eex` and `.leex` (family `elixir`, no import target). One scanner, [heex.ts](heex.ts), reads Phoenix templates and LiveView `~H"""` sigils in `.ex` files: templates are screens, `phx-*` attributes interactive elements joined to `handle_event` by `PhoenixEventResolver`, links and forms carry `request`, and components are sub-components (rules in `readHeex`).
