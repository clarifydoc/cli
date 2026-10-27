# Changelog

User-facing changes to the `clarifydoc` CLI, its MCP server and its library exports. Earlier versions are
recorded in the git history only.

## Unreleased

### Removed

- The benchmark scoring helpers are no longer exported from the package (`scoreSet`, `rankOf`,
  `meanReciprocalRank`, `scoreTokens`, `estimateTokens`, `mean`, `poolSetScores`, `scoreSampledLinks`,
  `computeCorpusMetrics`, `linkRecords`, `diffCorpusLinks`, `isJoinableTarget`, `startsWithHole` and their
  types). They were never part of the analyzer.

### Added

- **Rust is read by a parser.** Rust's functions and calls come from its ANTLR4 grammar too, under the same `antlr`
  feature and per-file fallback (`no-antlr:rust` keeps the patterns). A method chain rustfmt wraps over lines keeps
  its receiver (`garage⏎.open_bay()` is `garage.open_bay`, `Builder::new()⏎.build()` is `Builder.new().build`),
  so the call resolves through declared types instead of by bare name, however long the chain; a macro's arguments
  are parsed as code where they are expressions (and read off their tokens where not); functions inside item macros (`cfg_if!`, `cfg_server! { … }`) and `macro_rules!` templates are read as the
  expansion would read them. Match-arm patterns (`Vote(v) =>`) and function-typed fields are no longer calls.
- **Elixir is read by tree-sitter.** Elixir's functions and calls come from tree-sitter-elixir under the `tree-sitter`
  feature, with the per-file fallback (`no-tree-sitter:elixir` keeps the patterns). Calls of names ending in `!` or `?`
  (`Repo.get!(Player, id)`, `Repo.insert!`, `Accounts.valid?`) and remote calls without parentheses are read, each
  `def` clause ends at its `end`, a head's guard and default arguments are the function's, and a template's calls
  (`phx-click={show_modal("x")}`, an attribute's `#{format_date(@at)}`) are still read from `~H` markup; `~w(…)`
  words, names quoted in strings and SQL inside strings are no longer calls. Grammar packages in the npm tarball and
  the Docker image now keep their licence files.
- **Dart named constructors stay with their type.** A named or factory constructor (`SquadEvent.selectPlayer`) is
  marked `isConstructor` and is no longer a candidate for a call through a value of the same name
  (`coach.selectPlayer()`), which it captured whenever that name was otherwise unique. The patterns now read
  `const factory X.y(…) = _Y;` redirecting factories and class names holding `$` (`_$UserImpl`), as generated code
  writes them.
- **Dart is read by tree-sitter.** Dart's functions and calls come from tree-sitter-dart (Dart 3, pinned to an upstream
  commit) under the `tree-sitter` feature, with the per-file fallback (`no-tree-sitter:dart` keeps the patterns).
  Functions whose parameters hold function types, functions without a return type, local functions and every
  constructor are read; a constructor's initializer list is its own (`: super(key: key)`, `: _repo = Repo()`); a
  method on a call's result or a `const` construction is named as the chain from it (`Navigator.of(context).push`,
  `Pipeline.addMiddleware`); object patterns (`case Error<T>():`), `assert` and declarations are no longer calls.
- **Swift is read by tree-sitter.** Swift's functions and calls come from tree-sitter-swift under a new `tree-sitter`
  feature, on by default with the same per-file fallback (`no-tree-sitter:swift` keeps the patterns). A nested
  function owns its calls; an `init` the pattern missed (`override init`, a generic one) is read; a call after `!` or
  `try`/`await`, a method on a call's result (`session.request(url).validate()`), a generic type's construction and a
  call inside string interpolation are named; `#expect(…)`, `#if` conditions, attributes (`@Sendable (…)`), case
  patterns (`.success(let x)`) and subscripts are no longer calls. `npm run setup` builds the grammar's wasm.
- **Rust trait and impl links.** A method a trait declares and another crate implements resolves to that
  implementation (`ClubShow.with_query` → `MatchPath.with_query` through `impl<T: Route> WithQuery for T`), and a
  trait's default method to the trait. An `impl` block in another crate adds methods to the type without becoming its
  declaration, so `Fixtures::new()` still resolves to the crate that declares `Fixtures`. `#[derive(…)]` traits count as
  implemented. A method on a typed chain (`Season::named().close()`, `w.Header().Set`) is kept and typed step by step
  instead of being dropped as noise.
- **Go and Lua are read by a parser.** The functions and calls of Go and Lua files come from their ANTLR4 grammars
  (antlr4ng) instead of line patterns: exact function extents (a Lua function ends at its `end`), calls written over
  several lines or without parentheses (`require "x"`, `db.Get[User](ctx)`), and nothing read from comments, strings
  or type conversions. Routes, data access and every other extractor still read the lines. A file the grammar cannot
  read keeps the pattern reading, and each file's `frontEnd` says which reading it got. `--feature no-antlr` (or
  `CLARIFYDOC_FEATURES=no-antlr`; `no-antlr:go` for one language) switches back to the patterns, which stay in place;
  `scripts/ab-features.mjs` compares the two on a tree. On large Go codebases the parse adds a few percent to the run.
- **A package that installs anywhere.** `npm run pack:standalone` builds the npm tarball with its
  dependencies bundled — grammars as WASM only, no install scripts — so `npm install clarifydoc` will
  compile nothing and need no Docker; `npm run smoke:tarball` installs it into an empty directory and
  checks every grammar and the MCP server. A release workflow packs and smoke-tests on a `v*` tag and
  publishes that tarball after a person approves.
- **Expo Router screens.** In a project that depends on `expo-router`, every component file under `app/` is a
  screen at its path (`(group)` folders and `index` dropped, `[id]` → `:id`). `_layout` and `+not-found`
  are not routes. `name+api.ts` serves `/name` once per exported HTTP-method handler.
- **File-based routes in a sub-folder.** Next.js, Nuxt, SvelteKit and Expo routes are read relative to the
  file's own sub-project, under that sub-project's frameworks. An app in `apps/web/` or `mobile/` used to
  get no routes at all, and a Next.js app beside an Expo app no longer switches Expo routing off.
- **Raw SQL handed to a driver names its table.** `pool.query("SELECT … FROM todos")`, `db.prepare(…)`,
  pg-promise, Knex `raw` and Prisma `$queryRaw` record a read or write of the table the statement names, on
  any receiver. These calls used to be missed unless the receiver was called `db`, and even then the
  table went unrecorded. A chain split over lines (`db\n  .prepare(…)`) is now read as well.
- **SQL in repository annotations names its table.** Spring Data and Room `@Query` (JPQL or native, across
  `+` concatenation and text blocks), `@NativeQuery`, JDBI `@SqlQuery`/`@SqlUpdate` and MyBatis
  `@Select`/`@Insert`/… record a read or write on the annotated method. Room's SQL-less
  `@Insert`/`@Update`/`@Delete`/`@Upsert` write the entity their parameter takes. JPQL's `FROM Order o`
  now reads `Order` as the entity rather than the keyword.
- **`useSWR('/api/user', fetcher)` is a GET of `/api/user`.** SWR hands its key to a fetcher that takes the
  URL as a parameter, so the URL is only visible in the hook — the call now links to its route.
  (A react-query key is a cache label and stays one.) postgres.js `sql.unsafe("…")` reads as raw SQL.
- **Django's own guards.** `@login_required`, `@permission_required(…)`, `@user_passes_test`,
  `@staff_member_required` and DRF's `@permission_classes([…])` on a function view, and `LoginRequiredMixin`
  / `PermissionRequiredMixin` / `UserPassesTestMixin` or a `method_decorator(login_required)` on a
  class-based view, become the route's `auth`. Only DRF `permission_classes` attributes were read before.
- **Data access in an inline route handler belongs to its route.** `app.get("/x", async (req, res) => …)`
  has no function to attribute a query to; it now goes to the route, so the route — and every screen
  that calls it — reaches the table.
- The MCP server rejects arguments a tool does not take, and enum values that match nothing, naming the
  nearest valid spelling (`paths` → did you mean `path`?). Both used to be read as "no filter", so a
  misspelt filter returned every row. Lenient spellings that already worked (`"20"` for a number, `API`
  for `api`, a comma list for an array) still do.
- The MCP server no longer analyzes a folder unasked when it is the home directory, a filesystem root, or —
  started without a path — a directory with no project marker above it. It says why and how to point it
  at the project; `clarifydoc_analyze` still works there.
- **Report: one search box across the report.** Routes by URL, screens, tables and files, opened in the tab
  that shows them; `/` focuses it from anywhere.
- **Report: why an architecture edge exists.** Clicking a C4 edge lists the file pairs behind it, grouped
  by the calling file — at every level, with its HTTP calls beside them where it is one.
- **Report: churn × complexity.** With git history, the Complexity tab plots every file by commits and
  total complexity; the top quarter for both — changed often and complex — is marked as the place to
  refactor first, and a dot opens its file's row.
- **Report: knowledge risk.** With git history and more than one author, Insights lists the files only one
  person has ever changed, ranked by the routes and entities they carry (migrations left out), and who is
  sole owner of how much.
- Report graphs open no smaller than a scale at which their labels can be read; Fit still shows all.
- `isTestFile(path, language)` and `getLanguageForFile(path)` are exported, so a consumer of a stored
  analysis tells test files from production ones by the analyzer's own per-language rules.
- `clarifydoc report --editor-scheme <scheme>`: file links in the report open in that editor (`cursor`,
  `windsurf`, `vscodium`, …) instead of VS Code.
- `LICENSE` (MIT), `SECURITY.md` — how to report a vulnerability, and exactly what network access the CLI
  makes — and this changelog.
- **ASP.NET conventional routing.** The route table a startup registers — `MapControllerRoute`,
  `MapDefaultControllerRoute`, `MapAreaControllerRoute`, MVC 5 `routes.MapRoute` (with its `defaults`) and
  Web API 2 `MapHttpRoute` — now routes the controllers no attribute routes: every public action becomes a
  row at `/{Controller}/{Action}`, under its `[Area]` or `Areas/X/` folder, keeping an optional `{id}` when
  the action takes one. Web API 2 actions answer the verb their name starts with. An MVC action with only
  `[HttpPost]` used to come out as `POST /`, and the unattributed GET form beside it not at all. A
  method-level `[Route("x")]` with no verb attribute is now a route (any verb). Without a registered
  pattern nothing is invented. A base controller's public actions are served under every controller
  deriving from it (`/Orders/List` from `CrudController.List`), and an override of a virtual action is
  an action of its own.
- **PHP includes.** `require`/`include` (and `_once`) of a path the file spells statically —
  `__DIR__ . '/lib/db.php'`, `dirname(__FILE__)`, a plain `'inc/header.php'` — are imports, and the
  functions an included file defines resolve from bare calls. Bare function calls and `new X` were not
  recorded as calls at all before, so legacy PHP had almost no call graph.
- **Go locals typed by the calls that make them.** `repo := store.NewRepo()` and `u, err := repo.Find(id)`
  type `repo` and `u` by the declared (first) result of the function or method called, so `u.Save()`
  resolves on `User` instead of by a unique method name. A function reached through an imported package
  or module (`store.NewRepo()`, Python `module.make()`) now types a call chain in every language.
- **`main.swift` runs.** Its top-level statements are the program's `<setup>`, with their typed locals; and
  a type written on one line (`class UserRepo { func save() -> Int { … } }`) keeps its methods. In every
  script-style regex language, `<setup>` now carries the typed locals of the top-level code.
- **Nested classes.** A class declared inside another — a Java `static class Builder`, a JUnit `@Nested`
  class, a Kotlin `class Inner`, a C# nested handler or record, a Python nested class with methods — is a
  class of its own with its methods. They used to be dropped entirely, methods and calls included. (A
  Python nested class without methods, like Django's `class Meta`, is configuration and stays out; a
  Kotlin `object` / companion is still folded into its class.) TypeScript `namespace` blocks are read the
  same way.
- **pytest fixtures.** A test's parameter is the fixture of that name — in its own module, else the
  nearest `conftest.py` — so `def test_save(user): user.save()` links to the method of the class the
  fixture returns (its annotation, `Iterator[T]` included, or the one class it returns or yields).
- **PHP namespaced functions.** `use function App\money;`, `\App\money()` and a bare `money()` inside
  `namespace App` resolve to the function declared in that namespace (then the global one, as PHP does),
  with no `require` needed — Composer's `files` autoload. `new App\Invoice()` links to its constructor.
- **Python C3 method resolution.** For `class D(B, C)` a member is looked up in C3 order, so
  `D().hello()` reaches `C.hello` before `A.hello`, as Python does.
- **Kotlin `typealias`.** A call on a value typed by an alias (`typealias Users = UserRepository`)
  resolves on the class it names.
- Web API 2 `[RoutePrefix("api/orders")]` is the controller's template; its routes used to come out at `/`.
- **React Native platform files.** `./Button` resolves to `Button.ios.tsx` / `Button.android.tsx` /
  `.native` / `.web` when no plain file exists, and dead-code analysis keeps every platform variant of a
  module alive instead of reporting them unreachable.

### Changed

- **A call through a barrel lands on the definition.** A named re-export (`export { fmt } from "./dates"`,
  Python `from .impl import Service` in a package `__init__`, with or without `as`) is followed to the
  function or class it forwards; the barrel stays the target only when the name comes from outside the
  project.
- A TypeScript/JavaScript field that only a method other than the constructor creates (`init() {
  this.repo = new UserRepo() }`, a lazy `this.db ??= new Db()`) is typed by that construction, so calls on
  it resolve. Constructions that disagree, or a constructor that sets the field from an untyped value,
  still state nothing.
- A relative import in the dependency graph is resolved the way the linker resolves it: `../lib/util` from
  `apps/a/src/main.ts` is `apps/a/lib/util.ts`. A path-suffix scan used to take the first file anywhere
  ending the same way — another app's `lib/util.ts`, or `Dashboard.vue` for `../hooks/useDashboard`.
  Sass, which also searches the build's load paths, falls back to the one sheet whose path ends that way.
- A workspace-package or tsconfig-alias import (rewritten to `packages/ui/src/index`) is an edge to exactly
  that file. Its last segment, `index`, also matched whichever other `index.ts` sat closest, which added
  a false dependency to nearly every importer in a monorepo.
- Dead code: PowerShell cmdlets (`[Cmdlet]`, `PSCmdlet`) and Roslyn source generators, analyzers and code
  fixes are loaded by their host and no longer reported unreachable.
- Kotlin: an annotated class, object or interface whose body opens and closes on one line
  (`@Suppress("unused") class K { fun x() = 1 }`) was misread by the grammar as an expression and lost; a
  `;` before its closing brace now keeps it, members and annotation included.
- `this.save()` / `self.save()` resolves on the enclosing class and its bases first — not on whichever
  class in the file happens to define a `save`.
- Dead code: a Java/Kotlin declaration under `@Suppress("unused")` / `@SuppressWarnings("unused")` is kept
  alive — the author's word that it is reached reflectively.
- Dead code: a `WebApplicationInitializer` (and Spring's dispatcher/security initializer bases) and a
  `@GlideModule` / `AppGlideModule` are loaded by the servlet container or Glide's generated code, and
  are no longer reported unreachable.
- An include path written without `./` (`include 'inc/header.php'`, `source lib/x.sh`) resolves from the
  project root, then beside the including file, then by a path suffix exactly one file has.
- **Next.js App Router paths.** Route groups `(shop)` and parallel-route slots `@modal` are left out of the
  URL, a root `app/page.tsx` / `app/route.ts` serves `/`, `[[...slug]]` is a catch-all and `[[id]]` an
  optional parameter, and `pages/_error` is not a page.
- A table seen only in a query no longer makes the querying file "declare a data entity" in its risk
  verdict.
- `clarifydoc schema` prints every field of the per-file JSON and of `project-summary.json`, required and
  optional, generated from the types so it can no longer fall behind. It used to print a hand-kept list of
  twelve.
- The report template's error messages no longer refer to a build script this package does not have.
