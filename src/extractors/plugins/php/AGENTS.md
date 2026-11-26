# PHP plugin

Reads `.php` with tree-sitter (parsed through the flat tree copy, `FLAT_TREE_LANGUAGES`: a PHP repository's cold CPU 11.7 s → 9.0 s, output identical); routes, views, Laravel facades and events, Livewire, Composer packages and service config are PHP's own extractors. The LSP image is Intelephense. Linking mechanisms shared with other languages stay in [../AGENTS.md](../AGENTS.md).

## Namespaces and class evidence

- The manifest sets `classNamesByEvidence` (separator `\`): a class head binds only through the calling file's evidence — a class declared there, an import naming it (its alias or a namespace prefix), the file's own `declaredNamespace`, or a fully qualified name, which keeps its backslashes in the call name (`\App\Other\Garage.park`). The unique-global guess never re-links a head so refused.
- A `use` of a namespaced class names the class declared in exactly that namespace (`ClassInfo.namespace` / `declaredNamespace`) wherever its PSR-4 directory sits — in the typed-receiver lookup and in the component graph. An import binds only what its path names.
- A file whose free functions live in a namespace says so in `declaredNamespace`; the linker joins `use function`, `\App\fn()` and same-namespace calls on it. Two same-named free functions in different namespaces of one file stay apart (the qualified-function index keeps them apart by line).
- A file opening several namespaces (`namespace A { … } namespace B { … }`, or `namespace A;` then `namespace B;`) records each class's own `ClassInfo.namespace` (a file with one states it once, in `declaredNamespace`). The linker's `filesNamedByEvidence` compares a candidate class on its own namespace and a caller on the namespace of the class around the call. A free function of a later namespace carries its own `FunctionInfo.namespace`, which the namespaced-function lookup reads instead of the file's first.
- `require`/`include` put the included file's functions in scope without naming them (`importsShareScope`): a bare call the file does not define links to the ONE included file that does (`import-file`). An include written with its extension (`include 'inc/header.php'`) resolves from the project root, then beside the importer, then by the one file whose path ends with it (`uniquePathEnding`).
- `ImportInfo.aliases` carries `use … as` renames.
- Dead code: PHP is a name-reaching language (`declaredNames`) — a class Composer autoloads is reached by being named; an import graph cannot prove files unreachable.

## Facades and static proxies

- A Laravel facade (`php/facades.ts`: `ClassInfo.staticProxyOf`) whose `getFacadeAccessor()` returns a token or `X::class` has no member of its own: a call on it runs on what the container yields for the token (`staticProxyLink` through the DI registrations, `di-binding`). `config/app.php` `'aliases'` are registrations of their short name. A token nothing binds links nowhere. This applies only when the evidence-named class declares no such member.
- The accessor may be `return self::TOKEN;` / `static::TOKEN` (a string or `X::class` constant of the facade) or several returns that all yield the same value.
- When the constant is not the facade's own, the accessor is `staticProxyOf: { constant }` and a trait's string constants ride its `fieldValues`; a `static::TOKEN` declared on a trait or a parent facade is `staticProxyOf.constant`; a class extending a `*Facade` base records its constants the same way. Core reads the one value the facade's traits and facade bases (up to four `extends` hops) agree on; a facade may extend such a base when it states the accessor itself.

## Traits

- Trait conflict clauses (`A::stamp insteadof B; B::stamp as logStamp;`) are per-mixin `excludes` and `aliases` on `ClassInfo.mixins[]`; every mixin walk of the linker honours them (`mixinMethodName`).
- A bare call inside a method resolves on the enclosing class and its bases, then the ONE mixed-in trait that defines it (`use`).

## Views and pages

- A plain `.php` page outside `views/` is a screen when the markup around its PHP tags holds a form, link or inline script, and a route at its own path when it reads `$_POST`/`$_GET`/`$_REQUEST`/`$_FILES`/`php://input` (`php/plain-pages.ts`): document-root directories such as `public/` are stripped; class or namespace files, library and framework directories, partials and front controllers are excluded. A self-posting form there links to its own route; relative `.php` targets resolve against the page's directory.
- Blade and CodeIgniter views go through the HTML reader and `render` links as before. CodeIgniter 2/3 is vendored with no manifest entry, so its framework rule matches on `meta.markerCandidates` (well-known relative paths collected into `ProjectInfo.markerFiles`).
- Column facts: PHP views re-check an element's column against the source's own line (`keepSourceColumns`); Blade re-checks it the same way (echo bodies are cut from its lines). A reader that rewrites tags states a column only when the line's text before it is unchanged.
- A Livewire `wire:click` links to the component class's method (`php/livewire.ts`, a dispatch resolver).
- Route names: Laravel `->name()` and `redirect()->route` feed `RouteInfo.name` / server-redirect resolution; `route:<name>` navigation targets resolve through `RouteInfo.name`.
- Laravel's `snake` helper keeps a run of capitals one word (`HTTPServer`), unlike the shared `underscore`; it stays in this plugin.

## Local types, loops and rebinding

- `$q = $p` is a `localTypes` alias (`aliasOf`), read in text order with blocks by enclosing statement; a parameter is the head's first write, typed by its declaration, so `$a = $c; $c = new Player();` keeps the declared type and an alias after the reassignment takes the new one; a loop around the alias follows the shared loop rule.
- `foreach` types its variable from a call or property chain (`from`/`element`) or a parameter or `@var` local typed `Player[]` / `array<int, Player>`; a native `array` result with a docblock `@return Player[]` keeps the docblock in `declaredReturnType`.
- A documented formal (`@param`) holds only while the body does not assign the name again (assignment, `??=`, `foreach … as`, `list`, `&`); then the local's own initializer type applies, or nothing.
- A type read off one assignment is `localTypes[].inferred`; core drops it when another assignment of the name is a call it cannot type or one typing another class (a construction guarding a null test of the same name, or the last straight-line assignment, keeps it). `$c ? a() : b()` marks its arms (`localTypes[].choice`). No per-assignment entry is stated otherwise.
- `declaredReturnType` and docblock `@return` type call chains; fluent `$this`/`static` returns follow.
- A per-argument walk of the enclosing function (`assignmentsOf`) is one walk per function building a name table, kept per tree in a `WeakMap`.

## Field writes and throws

- `FunctionInfo.fieldWrites` / `throws` are stated for PHP: a class is named through the writing file's `use`/namespace (`class-evidence.ts`, the symbol linker's own rule); `self::$x` / `static::$x` read as `this`.
- A type written through a namespace path is stated as `ParamInfo.typePath` / `PropertyInfo.typePath` beside the bare `type`; core binds it through the writing file's evidence, so a namesake class of the writer's own namespace never answers for `\App\Models\Club $c`.
- A static property written from outside its class (`Club::$count = 0`) is a write with `fieldWrites[].class` set to the class as written, bound like a thrown type.
- A docblock `@throws` is a `declared` thrown type beside the body's.

## Value flow

- `php/value-flow.ts` reads string callables, `[$this, 'save']` / `[Club::class, 'save']`, first-class callable syntax and `Closure::fromCallable` as seeds, moves them through variables, properties and array elements, and emits invokes for `$f()`, `($this->h)()`, `$m['a']()` and the callback argument of `call_user_func` / `array_map`-style builtins.
- A closure or arrow function held in a value, or written as an argument (`run(fn() => $this->onFullTime())`), stands for the project functions its body calls (at most four, counted by core; `save` / `this.save` / `Club.save`) or copies the cell of a held value it runs; it gets no function of its own, and a call on its parameters, a builtin or an untyped receiver states nothing.
- PHP 8 named arguments (`schedule(callback: $this->f(...))`) are an `arg` with `name` (index -1); core binds the formal whose `ParamInfo.argumentLabel ?? name` is that name; an unknown name binds nothing.
- Top-level statements state value flow on `<setup>` (`meta.ast.moduleValueFlow`; a `return` there states nothing). A list or map handed to a parameter passes its elements (`arg` `elements: true`, set where the list's element cell is written or the argument is a parameter; core joins the caller's `<arg>.[]` to the formal's — PHP and Ruby only). `$this->$m()` stays unlinked.

## Request wrappers and service config

- A project method that hands its path parameter to a client and picks the verb from another (`$conn->request(Verb::DELETE, "/x/" . $id)`) is joined by core's `expandRequestFactories` from each call site's `FileAnalysis.pathArgCalls` (`php/path-arg-calls.ts`), which may name the `receiverType` the method is looked up on and the `method` the site selects.
- `php/service-config.ts` states a `serviceConfig`: `config/*.php` arrays, `env('X', '…')`, `config('k')`, Guzzle `base_uri`, `Http::baseUrl`; a config entry names the variables that override it in `ConfigEntry.envNames`. Plugins keep no module state. The labelled fixture has a Guzzle / `config()` caller with an `archive` decoy.
- PHP is among the plugins that read the SQL handed to a call and emit their own row for the statement, with `joinedTableRows` for the rest.
- Composer: its autoload map is `installedOwners` of the package manager; a Composer library's modules are its API, never judged dead.
- Parameter text such as `$var`, type-first and name-first forms and `$this->obj->method(` chains are parsed by the shared regex helpers.

## Other

- Control-flow graphs for PHP are exact (tree-sitter grammar; `clarifydoc cfg`).
- The plugin's `index.ts` extracts routes through `RegexLangSpec.extractRoutes` (route extraction for Laravel attributes is the documented example of that hook).
- Shared regex helpers parse a PHP parameter list (`$var`, type-first and name-first forms) and `$this->obj->method(` chains.

## How core passes read it

- `classNamesByEvidence`: a fully qualified class keeps its backslashes in the call name (`\\App\\Other\\Garage.park`), a namespaced free function is `\\App\\fn()`; neither is guessed by the unique-global name. A `Factory::getInstance()->m()` chain is typed through the declared return type.
- Link spelling: `url('cars.show')` and Ziggy `route()` / `route('clubs.show')` are named-route links, resolved through `RouteInfo.name`.
- Constructor params of a class are found by the method named `__construct`; a type read off one assignment is `localTypes[].inferred`.
- Config: `config/*.php` with `env()` is the `serviceConfig` source.
