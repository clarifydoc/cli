# Scala plugin

Reads `.scala` and `.sc` scripts (`family: "jvm"`, `parsing: "regex"`) through the regex path with a tree-sitter reader for functions and calls; `build.sbt` projects are sub-projects.

## Files and front end

- A regex language: the spec's extractors read the lines, the tree-sitter reader (`meta.treeSitter`, [tree-sitter.ts](tree-sitter.ts), feature `tree-sitter`, switched off by `no-tree-sitter:scala`) supplies functions and calls from the grammar the manifest registers while `parsing` stays `"regex"`. An anonymous instance's methods lend their calls to the function building it. A call through a path is named by every name back to its head (`club.league.relegate`, `PlayerService.instance.add`: `nameCall`'s `paths`, [../shared/callee-names.ts](../shared/callee-names.ts)), so the linker types the receiver from the head.
- The tree-sitter grammar is pinned to an upstream commit: npm's `tree-sitter-scala` 0.24.0 fails on a fifth of Play and Scala 3 files and v0.26.3 on 3 of 3,427.
- Blocks end by braces or by indentation ([blocks.ts](blocks.ts), on the shared `brace-code` lexicon).
- `.sc` is shared with SuperCollider: the plugin's `preprocess` refuses those files with `{ skip }`.
- Line-based DI readers ([di.ts](di.ts)) use the shared `code-lines.ts` helpers (`codeOf`, `splitArgs`, `statementsOf`, …).
- Reachability: a declarative spec from `reachability-kit` ([reachability.ts](reachability.ts)).

## Sub-projects, packages and commands

- `build.sbt` is a project marker ([project-markers.ts](project-markers.ts)); `isProjectRoot` skips sbt's `project/` meta-build. The manifest's `declaredProjects` hook makes `lazy val api = (project in file("api"))` a sub-project too, with `dependsOn`/`aggregate` read as `SubProject.references` by val name ([sbt-projects.ts](sbt-projects.ts)).
- sbt contributes a manifest to the maven ecosystem ([package-manifests.ts](package-manifests.ts)); only one plugin may define the ecosystem's matching.
- Where imports name packages (`importsNamePackages`), an import is the files whose `FileAnalysis.packageName` it names, narrowed to those declaring the member it names; a file also sees its own and enclosing packages.
- Test command ([test-command.ts](test-command.ts)): `sbt "testOnly *ClubSpec"` — the class a test name leads with, else the file's name; `build.sbt` gives `sbt compile` / `sbt test` project commands ([project-commands.ts](project-commands.ts)).

## Linking rules

- Parameterless `def` ([getter-reads.ts](getter-reads.ts), run from `extractValueFlow`, so both front ends state the same): a `def` with no parameter list (`def total: Int`, `def name = "x"`) carries `FunctionInfo.getter` and is called by a read — `club.total`, a bare `total` in the class or its subclass, `this.total`, `${club.total}` in an interpolated string — recorded as `CallInfo.read: "getter"` (the Dart mechanism). The linker links one only to a function marked `getter`, so a `val`, a field, a parameter, a local or a lambda binder of the name and a `def` taking a parameter list draw no edge. A receiver-chain hop through such a def takes its declared return type (`getterResult`), so `repo.find(1).rival.total` links.
- `extension` blocks are `ClassInfo.extension`, a part of the type.

## Member effects

- `FunctionInfo.fieldWrites`/`throws` are stated ([member-effects.ts](member-effects.ts)). A `def this(…)` states no writes: it initializes. A named argument on its own line (`name = n,` inside `copy(`) is no write. `@throws[T]` is `declared`. A member the type's body declares without a type, `var visits = 0`, is stated once as an `init` declaration so core knows it. `throw LeagueError.Missing` names the enum.

## Request schemas, security and routes

- Routes ([routes.ts](routes.ts)), JAX-RS ([jaxrs.ts](jaxrs.ts)), request schemas ([request-schema.ts](request-schema.ts)) and security rules ([security-rules.ts](security-rules.ts)) are read here; a Play route names its handler `Class.method`, so the linker binds it only to that class's method (never, by name alone, to a same-named method of another class — an action the class lacks stays unresolved).

## How core passes read it

- The impact report's test command is `sbt testOnly`.
