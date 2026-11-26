# PHP plugin

Reads `.php` with tree-sitter (parsed through the flat tree copy, `FLAT_TREE_LANGUAGES`); routes, views, Laravel
facades and events, Livewire, Composer packages and service config are PHP's own extractors. The LSP image is
Intelephense. Linking mechanisms shared with other languages stay in [../AGENTS.md](../AGENTS.md).

## Map

- [manifest.ts](manifest.ts) — static facts: `classNamesByEvidence` (namespace evidence, the rule is in its comment), `importsShareScope`, markers. [meta.ts](meta.ts) wires the hooks; [index.ts](index.ts) extracts routes through `RegexLangSpec.extractRoutes`.
- [functions-classes.ts](functions-classes.ts) — functions, classes, properties, mixins (trait conflict clauses), `localTypes` (aliases, loops, rebinding, `inferred`/`choice`); constructor params are found by the method named `__construct`.
- [imports-exports.ts](imports-exports.ts) — `use`, `require`/`include`; [di.ts](di.ts) — container registrations and lookups; [facades.ts](facades.ts) — Laravel facade `staticProxyOf`.
- [member-effects.ts](member-effects.ts) — `fieldWrites`/`throws`; [value-flow.ts](value-flow.ts), [call-hooks.ts](call-hooks.ts) — callable values and call typing.
- [views.ts](views.ts), [blade.ts](blade.ts), [plain-pages.ts](plain-pages.ts), [livewire.ts](livewire.ts) — pages, screens and their requests; a Livewire `wire:click` links to the component method through a dispatch resolver.
- [path-arg-calls.ts](path-arg-calls.ts) — request wrappers joined by core's `expandRequestFactories`; [service-config.ts](service-config.ts) — `config/*.php`, `env()`, Guzzle `base_uri`.
- [routes/](routes/) — Laravel, Symfony, CodeIgniter route readers and resolvers; `laravel-*`, [entities.ts](entities.ts), [data-sources.ts](data-sources.ts), [data-mutations.ts](data-mutations.ts) — Eloquent, migrations, SQL.
- [package-manifests.ts](package-manifests.ts), [packages.ts](packages.ts) — Composer (its autoload map is `installedOwners`); [reachability.ts](reachability.ts) — dead code by name.

## Rules

- A class is never guessed by the unique-global name where evidence exists: a fully qualified class keeps its backslashes in the call name and a namespaced free function is `\App\fn()`. A `Factory::getInstance()->m()` chain is typed through the declared return type.
- Link spelling: `url('cars.show')` and Ziggy `route('clubs.show')` are named-route links, resolved through `RouteInfo.name` (Laravel `->name()`, `redirect()->route`).
- A bare call inside a method resolves on the enclosing class and its bases, then the ONE mixed-in trait that defines it; every mixin walk honours `excludes`/`aliases` (`mixinMethodName`).
- Plugins keep no module state. Dead code: PHP is a name-reaching language (`declaredNames`); a Composer library's modules are its API, never judged dead.
- Laravel's `snake` helper stays in this plugin (a run of capitals stays one word, unlike the shared `underscore`).
- Control-flow graphs are exact (`clarifydoc cfg`). The labelled service-config fixture has a Guzzle / `config()` caller with an `archive` decoy.
