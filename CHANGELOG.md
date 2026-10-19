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
  pattern nothing is invented.
- **PHP includes.** `require`/`include` (and `_once`) of a path the file spells statically —
  `__DIR__ . '/lib/db.php'`, `dirname(__FILE__)`, a plain `'inc/header.php'` — are imports, and the
  functions an included file defines resolve from bare calls. Bare function calls and `new X` were not
  recorded as calls at all before, so legacy PHP had almost no call graph.
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
