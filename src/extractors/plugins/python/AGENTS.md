# Python plugin

Reads `.py` and Jupyter `.ipynb` files with tree-sitter (a flat-tree language, so the copy is byte-identical to the real tree); Flask, FastAPI, Django/DRF, Celery, SQLAlchemy/SQLModel/Alembic, aiosql, GraphQL and pytest facts hang off the same `FileAnalysis`.

## Files and front end

- Tree-sitter plugin; `Python` is in `FLAT_TREE_LANGUAGES`. A Python `Protocol` is `ClassInfo.kind: "interface"` with `structural: true`.
- Notebooks (`.ipynb`) are owned by this plugin and read through its `preprocess` ([notebook.ts](notebook.ts)):
  - code cells of a Python kernel (`language_info.name` / `kernelspec.language`; none stated = Python; R, Julia… are skipped with their reason) are joined in order with a blank line between cells; markdown cells and outputs are dropped;
  - IPython line magics (`%x`, `!cmd`) are blanked, and every `%%` cell magic except `%%time`/`%%timeit`/`%%capture`/`%%python`/`%%prun`/`%%debug` (`%%bash`, `%%sql`, `%%writefile`…) is blanked whole;
  - code past 2 M characters is skipped; facts carry the lines of the CONCATENATED text, not the notebook JSON;
  - `PreprocessOutcome.codeOnly` makes the line count and the `minified` flag come from that text (an image output line would otherwise mark every notebook minified and unauthored).
- Extension-less scripts whose `#!` names a Python interpreter are Python files (manifest `shebangInterpreter`).
- `python-tokenizer.ts` backs the type-reference walkers; `stripPythonNonCode` scans char codes and copies kept stretches by `slice`, never a per-character array.
- `extractPythonDecorators` reads the `decorator` children of `decorated_definition`; the call walk's read set adds `decorator`, and `collectExtraCalls` reads Python decorators as calls.
- `typeNamedByReceiver` converts snake to Pascal (`match_report` → `MatchReport`).
- Security: the assignment rule is `raw` because `securityPreprocess` blanks strings; a finding whose value is prose or a namespaced name (`isKeyShapedValue`) is dropped; bandit's `# noqa: S105`/`S106`/`S107` silence hardcoded-secret only (`suppressionOf`).
- The known-package table classifies the standard library's `shutil`/`zipfile`/`tarfile` as filesystem and `smtplib` as email boundaries (never `os`/`pathlib`); the known-package rule never classifies a Python import (the standard library and `sys.path` shadowing go through `standardImport`).
- Cheap gates: a whole-text gate asked per call site is computed once per file (`managerAssigned`); a per-argument walk of the enclosing function (`assignsTo`) is one walk per function building a name table kept per tree in a `WeakMap`.

## Imports and scope

- `ImportInfo.aliases` (local → exported) is filled for `from x import a as b`; the import index asks Python's own resolver for the name an aliased import was exported as (`from app.api import api as articles` names module `api`).
- A dotted import resolves by the package its directories spell, never by the leaf file name alone. The manifest's `standardImport` hook (the standard library and `sys.path` shadowing) keeps an external import off a project namesake; a package a manifest declares is no project file either (a dotted `azure.storage.blob` maps to `azure-storage-blob`).
- An import inside a function binds in that function only (`ImportInfo.scope`, the function's lines, decorators included). `classifyCalls` gets the file's unscoped imports plus the scoped ones whose scope holds the callable, so a sibling function's bare `helper()` is no call into that import; a function nested in the importing one keeps it.
- Star imports (`from app.hub import *`) are followed through the modules they name (three hops, one definition, `starChainDefinition`, Strategy 6b); a bare call links only when exactly one file defines the name.
- A package `__init__`'s `from .impl import X` is followed by a cross-file call to the definition, unique-or-nothing.
- A module-level alias (`s = attrs`, `FileAnalysis.nameAliases`) leads to the function it names.
- `directoryIndexStems` is `__init__`: a URL helper called through a module binding (`urls.club_url(id)`, `from league.utils import routes`) is looked up in the imported module's file only where the head is the module itself, never where it is a named export.
- A local typed through a module the file imports (`m.Club` after `import league.models as m` / `from league import models as m`) takes the class that module's file declares (`moduleQualifiedType`), never the leaf name's namesake.
- A script that is RUN rather than loaded (`subprocess.run`, `fork`) carries `executes: true` on its import and shares nothing.
- `meta.ast.filePathReads` reads `open(…)`, `Path(…).read_text()` and `os.path.join` with literal parts only; a hole, a variable or another receiver states nothing.
- `multipleInheritance` makes member lookup follow the C3 order over `extends` + `implements`.
- `moduleLocalsInScope`: a module-level binding types a call where the function reads it. A function that rebinds the name (assignment, loop or `with … as` target, walrus, import, nested `def`/class, `global`/`nonlocal` — also one a nested function declares —, `match` capture, `del`) lists it in `FunctionInfo.boundNames` (`rebindingNamesOf`), and `scopedName` skips the module's `<setup>` local for it (and for a function nested in one that rebinds or takes it as a parameter).
- A module variable a function declares `global` and assigns is a second initializer, so its `<setup>` type is dropped unless the module statement annotates it.
- A class-body construction (`car = Car()`) is a typed static property only when a method calls through it (`self.car.x()`), no method assigns it on the instance, and the call is no ORM column or pydantic `Field`; it types `self.<name>`.
- `transparentTypeWrappers` lists `Annotated`.

## Linking rules

- **Typed locals.** `q = p` and `(q := p)` are `localTypes` entries with `type: ""` and `aliasOf: "p"`. A parameter-typed alias is read by the fact table (it keeps each name's latest binding and its block); a loop around the alias matters only when the head is bound again LATER in that loop body, and then the alias is typed only if that binding states the same type. The local-type gate skips an alias-only body unless a parameter is annotated.
- **A local bound to a module.** `FunctionInfo.returnsModule` is the module every `return` of a function hands back as an import states it (`def load(): import backend; return backend`, `from league import club … return club`; a function-level import first, then the file's); `localTypes[].module` is the literal of `m = importlib.import_module("league.club")` for a name bound once and never a parameter ([returned-modules.ts](returned-modules.ts)). Core's `moduleLocalCall` (symbol-linker) links `m.save()` to that module's own top-level `save` (`import-file`, INFERRED) only when every binding of the local agrees on one module resolved by the plugin's `resolveImport`; a non-literal `import_module(name)`, a conditional return, a returned class, or a method of a class in the module links nothing, and a namesake `save` in a third module is never reached.
- **Initializers.** A local's initializer call of a same-file function is typed by its declared return. `a() if c else b()` marks its arms with `localTypes[].choice`. Python (like Java/Kotlin/C#/PHP) states no per-assignment entry at all.
- **Narrowing per call.** `match` class patterns (`case Club():`, `as`, `|` alternatives) set `CallInfo.receiverType` only on calls inside the region the pattern guards.
- **Loops.** `for i, (a, b) in enumerate(pairs)` / `.items()` over `list[tuple[A, B]]` / `dict[A, B]` type the element through `rowShape`.
- **Rebinding.** A documented `@param` holds only while the body does not assign the name again; a module-level typed binding never types a call on a name the function rebinds.
- **`save` leaf.** `save` is a write on an instance or an ORM receiver, but not on a module the file binds with a plain `import x [as n]` (`np.save`, `torch.save`, `onnx.save` — no database library exposes a module-level `save`; a project module bound that way gives no call-site row either, the write inside its own function keeping its row — `savesThroughLibraryModule`).
- **Dependency injection.** A FastAPI dependency's callable reads what it reads whether or not its name says it checks the caller; `CallInfo.routeParamsByName` marks a callee the framework hands the route's parameters by name (`Depends(x)` and the dependencies it asks for in turn).
- **Argument origins and request reads.** [arg-origins.ts](arg-origins.ts) states `CallInfo.argOrigins`; [request-access.ts](request-access.ts) states `FunctionInfo.requestAccess`; [request-schema.ts](request-schema.ts) holds the plugin's `requestSchema` hooks that map a body-bound class to JSON.
- **Class constants.** Fact maps (`fieldValues`, `moduleValues`) are read by own property only (`ownValue`).

## Value flow ([value-flow.ts](value-flow.ts))

- Facts stated: assignments, loop targets, `x.append(f)`, list/tuple/set/dict literals (a container is ONE cell with its elements; a dict also keeps a literal key as its member; `self.x[…]` has no second member level), `functools.partial(f, …)` as a seed of `f`, `return`, positional arguments by written index.
- `invoke` is stated for a call of a local, a parameter (not a test's or fixture's, which pytest injects), a module name its own statements bind, `self.<field>` the class assigns (never a method) and `table[k](...)`.
- A `global` assignment goes to `moduleValueFlow`.
- A keyword argument `schedule(callback=f)` is an `arg` with `name` (index -1) binding the formal of that name; a `**kwargs` formal or an unknown name binds nothing.
- A module-level `name = lambda …` is a function of its own. A lambda written inside a function and landing in a cell (local, `self.x`, list/dict element, positional argument, return) has no function of its own and stands for what its body calls: a seed for each project function it names (`save`, `self.save`, `Club.save`), a `copy` for a name that holds a value, nothing for a call on its own parameter, a local, or a name an import of the standard library or a known external package binds (`json.dumps`, `from time import sleep` — none counts toward the four, and an argument handed to such a call states no `arg` fact), and nothing when the project functions it calls come to more than four (counted by core over the facts sharing the lambda's id; the plugin states up to sixteen names).
- Parameter types from call sites: an `any`/untyped parameter takes what every call site passes (`dispatch:param-type`; never when the function is handed on by name).

## Routes and frameworks

- [routes.ts](routes.ts): Flask and FastAPI decorators and mounts; Django guard decorators.
- **FastAPI mounts.** An `include_router(x, prefix=…)` of a router the same file declares (`x = APIRouter()`) prefixes only the routes decorated on `x`: a router variable owns its routes, a receiver included in turn composes first, the include adds no mount row (`applyLocalIncludes`); an imported router still goes through the cross-file mount.
- **FastAPI settings prefix.** `include_router(…, prefix=settings.x)` (for instance `include_router(api, prefix=settings.api_prefix)`) leaves the mount `prefixUnresolved: "mount:settings.api_prefix"`. [settings-prefix.ts](settings-prefix.ts) (route resolver, before mounts compose) types the holder — a local or module `settings = Settings()`, `get_settings()` through that function's declared return, an instance imported from the module that builds it — and takes the class attribute's literal default (`FileAnalysis.moduleValues`, own or a base's). An environment override is not read, and a project subclass stating another value, a default with a hole, or no default leaves the mount unresolved.
- **FastAPI guards.** [fastapi-guards.ts](fastapi-guards.ts) states a route's `dependencies=[Depends(x)]` callables (and its router's, in the same file) as `RouteInfo.middlewareCalls`; those of a project router class's `__init__` (and a class-based-view base) as `RouteInfo.inheritedMiddleware` naming the class's file. A dependency is a guard only when its name says it checks the caller.
- **Django urlconfs and DRF** (`django/`): urlconfs and DRF routers are per-file `routeFacts` (urlpatterns entries, `router.register`, view-class attributes) joined by the `django-urlconf` route resolver ([resolver.ts](django/resolver.ts)):
  - from `ROOT_URLCONF` through `include("mod")` / inline lists / `*router.urls`;
  - ViewSet actions from mixins + project methods + `@action`; `path()` converters and `re_path` regexes become `{name}`;
  - `include("allauth.urls")` and `include("allauth.account.urls")` that resolve to no project file expand through `libraryUrlconfEntries` into the account routes (handlers `allauth.account.views.<view>` under the include prefix); a project that vendors the module is walked as its own urlconf, and a same-named project view still adds nothing.
- **DRF dispatch.** The `drf-action` dispatch resolver ([viewset-actions.ts](django/viewset-actions.ts)) follows a router route whose action is DRF's own (none written, or handed on with `super().<action>()`) into the hooks it calls — `get_queryset`, `get_object`, `perform_update`, … — linking the nearest project override, or the class stating `queryset`. `create`/`update` hand the request to the view's `serializer_class`; the `drf-serializer` resolver ([serializer-dispatch.ts](django/serializer-dispatch.ts)) links a `serializer.is_valid()` / `.save()` whose class is known (a typed local, `self.get_serializer(…)`, `perform_create`/`perform_update`'s argument) to what DRF runs on it: `validate_<field>` for a field the class or its `Meta.fields` has, the fields' `validators=[…]`, `validate`, and `create` or `update` as the construction states (`CallInfo.key` `drf-serializer:create|update`). The shared rules are in [drf.ts](django/drf.ts).
- **Django library views** ([library-writes.ts](django/library-writes.ts)): DRF's generic views and `ModelSerializer.save()` write their model; django-allauth's account views a route's handler names through an import of `allauth.account.views` (`login`, `signup`, `password_change`, `password_set`, `password_reset`, `password_reset_from_key`, as functions or classes, aliases honoured) act on the user model (`DataSourceInfo.authUser`, resolved to the project's own user model by the entity pass); a project view of the same name in another module adds nothing.

## API calls

- [http-clients.ts](http-clients.ts): `httpx.Client`/`AsyncClient`, `aiohttp.ClientSession`, `BaseUrlSession` with a `base_url` literal or `os.environ`/`os.getenv` value, held in a name or `self.x`, state `httpClientRegistrations`; a name bound twice registers nothing. The api-call row names its receiver as `client`.
- `meta.serviceConfig` states client bases; a config entry names the variables that override it in `ConfigEntry.envNames`; plugins keep no module state.
- Labelled fixture: `test-fixtures/sample-microservices` (httpx/aiohttp callers with an `archive` decoy).
- gRPC stubs: `…_pb2_grpc.GreeterStub` (`grpcStubService`); a Thrift handler `ClubService.Processor(handler)` is a `thrift-handler` route fact.
- MQTT: paho/aiomqtt calls carry `DataSourceInfo.topicSyntax: "mqtt"`; a topic from `from … import` is `target: null` + `targetRef`; `subscribe([("a", 0)])` gives one row per topic.
- Dapr pub/sub, pika/AMQP, Kafka and Celery tasks are queue nodes of the data-access graph; module-level code attributes to the file's `<setup>`.

## Data access and entities

- Entities and relations: [entities.ts](entities.ts).
- **Statement builders.** The SQLAlchemy reader never gives a statement builder (`select(…)`, `func.count(…)`, `sa.select(…)`) a row of its own that names no model: `select(…).filter_by(…)` takes the model its `select` names (a parameter's stays with the session call's row); a bare `func.…` yields none (core would otherwise back-fill the import's module name `sqlalchemy` as the table). On a `select(…)` chain, each `.join(Y, …)` whose first argument names a class (`Player`, `models.Player`) or a loop variable of such classes is another read of that table; a string's `"-".join(…)` and a project function named `join` never are.
- **Schemas.** A model's `__table_args__ = {"schema": "league"}` prefixes its `__tablename__`. An Alembic revision's `op.create_table(…, schema="league")` (and `drop_table` / `rename_table` / `add_column` / `drop_column` in `upgrade` only) yields a schema-qualified table (`league.clubs`) plus `schemaOps`, so the data model joins what code names under that schema; a same-named decoy without `schema=` or under another schema stays a different table; the revision's model copies are still not entities ([alembic-schema.ts](alembic-schema.ts)).
- **SQLModel.** `class Club(SQLModel, table=True)` with `league: Optional["League"] = Relationship(…)` is an entity relation; a non-`table` SQLModel schema with the same nested shape (`league: Optional[LeagueRead] = None`) is not an entity and yields no relation.
- **`@declared_attr`** (or `@orm.declared_attr`) whose body is `return relationship(…)` / `return orm.relationship(…)` is the same relation as a field assignment; one returning anything else is not.
- **Loops over a constant of classes.** `for model in MODELS:` / `MODELS.values()` / `.items()` over a module-level `MODELS = {…}` / tuple / list / set a module assigns exactly once is a row per class listed, as for a literal written in the loop (`for f, model in {"a": Tag, "b": Tool}.items()`, `for model in (Tag, Tool)`; a bare dict walks its keys and reads none). Classes a function adds afterward are included: a `global MODELS` reassignment to a literal, `MODELS["k"] = X`, in-place `MODELS.append(X)` / `extend` / `update` (no `global` needed), or `MODELS += […]` with `global`. A local rebind of the same name without `global` is a decoy and contributes nothing.
- **Generic repository.** The entity pass types a base repository's `self.model` from the constructors of its subclasses that set it (`self.model = Club` in `__init__`, read from the assignment rows), so `filter_by(**{key: value})` in the base gets its entity; every same-named class must agree, and one storing another class or a non-entity leaves it unlinked. A column the repository takes as a parameter (`DataSourceInfo.whereFields[].fieldParam`) is the string literal the call walked through hands it (`repo.get_one(slug, "slug")`); a key no call states as a literal gives no row. Repository-pattern attribution over `Generic[…]` bases goes through the shared `attributeRepositoryAccesses` with this plugin's spelling knobs ([repository-access.test.ts](repository-access.test.ts)).
- **Entity parameters.** A helper whose statement queries the model one of its parameters holds (`DataSourceInfo.entityParameter`: `def model_count(model): select(func.count(model.id))`) reads, at each call that hands it an entity class, that entity.
- aiosql named queries ([aiosql.ts](aiosql.ts)): an argument given by name lands on the callee's parameter of that name and is the only kind followed through a dispatch link. `where`/`filter`/`filter_by` and Django lookups are `whereFields`.
- Data-source rows: [data-sources.ts](data-sources.ts); mutations: [data-mutations.ts](data-mutations.ts).

## Member effects

- `fieldWrites`/`throws` in [member-effects.ts](member-effects.ts): a Python `__init__` states its `self.x` writes as `init` declarations core never lists as writers; thrown types are read (`raise T`); a qualified name (`requests.HTTPError`) binds by its last segment only through a qualifier the project backs (a Python module path).

## Packages

- A `requirements.txt` is read through `readTextFile` (UTF-16 by its mark: a file written by Windows PowerShell 5.1 lists its packages); a dotted import maps to its package name (`azure.storage.blob` → `azure-storage-blob`). Manifests: [package-manifests.ts](package-manifests.ts).

## Reachability

- [reachability.ts](reachability.ts) is bespoke: imports + `__init__` chains, `__main__`, `module:`/`file:` references, server commands; a notebook is an entry (`notebook (runs top to bottom)`), so the project modules it imports are alive.
- `typeUsageComplete` is true: a class with no `typeUsages` record is named by nobody; a file that hands a module on whole (`from .x import *`) is a star forwarder charged with it when a change removes a name.
- `FileAnalysis.moduleNames` (module-level assignments with the lines each owns) lets `impact` charge only the importers that read an edited constant.
- Libraries are not judged: a published package's modules (pyproject library) are its API.

## Tests, taint, commands

- [taint.ts](taint.ts): the `ast.taint` hook of `handlerTaint` (tree-sitter).
- [test-command.ts](test-command.ts): pytest node ids; [project-commands.ts](project-commands.ts) reads how a project is built, tested and started. `testSetupRuns` names Django's migrations and `AppConfig.ready()` under pytest-django, which the test-reach verdict counts as tested.
- A test's or fixture's parameter is injected by pytest and is never an `invoke` target ([pytest-fixtures.ts](pytest-fixtures.ts)).

## How core passes read it

- Entity parameters: `model_count(Club)` / `model_count(model=Club)` (reported as `model=Club` after the positional arguments) binds the entity a helper's `model` parameter queries (`def total(model): return model_count(model)` is a helper of that parameter too, three levels up); a loop over a literal or module-level constant of classes is a row per listed class.
- A qualified base written `base.Club` / `models.Car` resolves through the class index, never a namesake beside the class.
- Redirects: `url_for`/`reverse` and Django templates' `{% url 'clubs:detail' %}` link by route name.
- Layers: `routers/api.py` mounting `routers/clubs/` is the routers folder using its parts.
- Impact narrowing on a module-level name: a module imported whole (`from p import m`) counts as a reader, spelled by the module's own stem; a value derived from the name in another file (`CAP = LIMIT * 2`) hands nothing on, and a line inserted right after a name reads as an edit of it. A `from .x import *` forwarder is charged only when the change takes a name away.
- A URL helper called through a module binding is looked up in the imported module's file when the head is the module itself and the module does not export it as a member (`mod urls`, `from . import urls`); `directoryIndexStems` makes a package's `__init__` stand for its directory.
