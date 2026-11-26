# Java and Kotlin plugin

Reads `.java` (`tree-sitter-java`) and `.kt`/`.kts` (`tree-sitter-kotlin`) with tree-sitter; two metas of one folder, both `family: "jvm"`. The plugin states facts; core resolves (see [core](../../../core/AGENTS.md)). Spring, JAX-RS, Ktor, Javalin/Spark, Android, Retrofit/Feign and the build files are read here; Spring XML, MyBatis XML and `AndroidManifest.xml` are read by [springxml](../springxml/AGENTS.md). Each file's own header comment holds its mechanism; this page is the map and the rules that span files.

## Rules a change must respect

- Plugins state facts, core resolves: never pre-resolve a DI binding, wrapper or type in the plugin. Fill `ParamInfo`/`PropertyInfo.type` as written, `localTypes[].from` (+ `member`, `element`, `choice`) for locals, and let core's `walkChain` do the rest.
- Visibility: a Java method is package-private (`isExported=false`) unless `public`; Kotlin defaults to public. Java `extractAnnotations` keeps the annotation name only (known gap); Kotlin decorators carry arguments.
- Framework rules (`frameworks.ts`) attach to ONE member meta only (`java`), so the registry sees each rule once.
- Both languages are in `FLAT_TREE_LANGUAGES`; a hidden zero-width MISSING token (Kotlin's automatic semicolon) is never visited, so `flattenTree` asks the real nodes for `hasError` (`readErrorFlags`).
- Only a wrapper the `valueOut` hook unwraps is listed; a wrapper with members of its own (`Optional`, `Provider`, Kotlin `Lazy`) is never a `transparentTypeWrappers` entry (see `JVM_UNWRAP_CALLS` in [manifest.ts](manifest.ts)).
- Java `this(…)`/`super(…)` are the calls `new <ownClass>` / `new <superclass>`; Kotlin delegation is the same ([kotlin-delegation.ts](kotlin-delegation.ts)). `localDeclarationTypes`: a declarator in a local declaration names a value, not a function, so `Runnable r = () -> club.save();` leaves `club.save` on the enclosing method's row.
- Conditional receivers: Kotlin `if (c) a() else b()` / `when (k) { A -> a(); else -> b() }` and conditional initializers mark their arms with one `localTypes[].choice` (a `when` needs an `else` entry and one expression per entry).
- `ImportInfo.inScope` marks Java `import static` and Kotlin function/`object`-member imports; `ImportInfo.aliases` carries a Kotlin `import … as`. The manifest's `packageScope` (Kotlin, with `directoryScope`) makes the declared `package`, not the folder, the scope; a Kotlin top-level `val` is a `moduleBindings` entry. `ownerPathTypes` keeps a type written through its owner (`Right.Builder`) and core resolves it with `ownerPathIn` ([../../../core/symbol-linker.ts](../../../core/symbol-linker.ts)): a path no owner bears out links nowhere.
- `blockingCalls`: Kotlin `runBlocking`, `Thread.sleep`, matched by name inside an `isAsync` function. SQL handed to a call goes through `joinedTableRows`/`sqlAccessRow`; `execute` is no HTTP method name.
- Kotlin: `calls.withSubjectsOf` names the implicit receivers of `with`/`apply`; `for ((club, player) in map)` loops are typed through the shared element chain (`extractors/shared/element-chain.ts`, `ChainRules.keys`/`entries`, a TYPED map root only); tuple patterns over `Pair`/`Triple` and data-class properties use `localTypes[].fromIndex` and the manifest's `tupleElementsOf`.
- Reachability: a declarative spec from `reachability-kit`. Java finds files by namespace, so an import graph cannot prove a file unreachable; framework-instantiated classes (`@Component`…) are passive, not entries. A manifest's `packageRoots` (`src/<set>/java/`) re-admits `target`/`out`/`bin`/`vendor` below it.
- LSP: jdtls runs with container `network: "bridge"` (it restores packages to type-check; `indexDelayMs` 10 s, needs `pom.xml` and a writable mount); Kotlin uses kotlin-language-server.

## Files

Build files and commands
- [manifest.ts](manifest.ts), [meta.ts](meta.ts) — the two metas, `valueOut`/`collectionElementOf` hooks and the wrapper tables.
- [package-manifests.ts](package-manifests.ts) — Maven (`selfName` = `groupId:artifactId` with the parent's group; a `<m:project xmlns:m>` root goes through `withoutRootPrefix`, [../shared/xml-scan.ts](../shared/xml-scan.ts)) and Gradle (registry maven; a `namespace` manifest is read for Android). [test-command.ts](test-command.ts), [project-commands.ts](project-commands.ts) — Maven/Gradle test and project commands.
- [service-config.ts](service-config.ts) — `application*.yml`/`.properties`: client bases, `routeBaseOf` (`server.servlet.context-path`), `proxySources` (Spring Cloud Gateway / Zuul), `normalizeKey`. [gateway-routes.ts](gateway-routes.ts) — gateway routes.

Structure and typing
- [functions-classes.ts](functions-classes.ts) — functions, classes, enum constants, calls; [call-hooks.ts](call-hooks.ts) — receiver typing and call narrowing; [arg-kinds.ts](arg-kinds.ts), [arg-origins.ts](arg-origins.ts) — overload facts.
- [java-anonymous.ts](java-anonymous.ts), [kotlin-delegation.ts](kotlin-delegation.ts), [kotlin-facade.ts](kotlin-facade.ts), [synthesized-members.ts](synthesized-members.ts), [type-bounds.ts](type-bounds.ts), [wrapper-elements.ts](wrapper-elements.ts), [element-types.ts](element-types.ts), [function-types.ts](function-types.ts), [member-effects.ts](member-effects.ts), [value-flow.ts](value-flow.ts) — each states one family of facts; read its header before editing.

Frameworks
- [routes/](routes/) — Spring MVC (`spring.ts`, `security-dsl.ts` guards joined cross-file, `meta-annotations.ts` reference implementation of route metadata: class-level annotations inherited by every method, an anonymous marker waives, a framework-default binding is `inferred: true`), JAX-RS (routes carry `RouteInfo.contract`), Ktor (`routes/ktor.ts`: `fun Route.x()` rows via `plugins/shared/router-functions.ts`), Javalin/Spark (`routes/javalin-spark.ts`: ApiBuilder + `crud`, `path` groups), Android navigation, GraphQL, actuator. A guard inherited from a Spring base class joins through `plugins/shared/class-guards.ts`.
- [di-bindings.ts](di-bindings.ts), [di-annotations.ts](di-annotations.ts) — `@Inject(TOKEN)`/`@Qualifier` is `qualifier`; autowire-by-name `DiBinding.matchesMemberName`; `@Profile`/`@Conditional*` `conditional`; `@ImplementedBy` `ifAbsent`.
- [aop-advice.ts](aop-advice.ts) — Spring AOP dispatch resolver (`dispatch:aop-advice`). [android-manifest-components.ts](android-manifest-components.ts) — manifest function (admitted by springxml) to the classes it names.
- [client-proxies.ts](client-proxies.ts), [retrofit.ts](retrofit.ts) — REST client proxies (`proxyOf`, `contract` calls), Retrofit/Feign; `@FeignClient(name = "league")` is a `service` base ref resolved through `spring.application.name`.
- [data-sources.ts](data-sources.ts), [data-mutations.ts](data-mutations.ts), [entities.ts](entities.ts) — SQL, JPA, Spring Data (derived queries and `@Query` placeholders name columns), Spring AMQP (`convertAndSend("x", "y", payload)` is exchange + routing key unless the third argument is a string literal), Paho/HiveMQ (`topicSyntax: "mqtt"`, a `Type.NAME` topic constant is `target: null` + `targetRef`), Dapr pub/sub; `@Value`/`@ConfigurationProperties` and `Environment.getProperty` mark `DataSourceInfo.configRead`, an env-shaped key also an `envVars` read.
- [file-path-reads.ts](file-path-reads.ts) — `filePathReads`; [request-schema.ts](request-schema.ts), [security-rules.ts](security-rules.ts), [taint.ts](taint.ts), [scheduled-jobs.ts](scheduled-jobs.ts), [migration-files.ts](migration-files.ts), [reachability.ts](reachability.ts) — as named.

## How core passes read it

- `@PathVariable("id") Long clubId` binds the handler parameter to the route parameter (`RouteParamInfo.variable`).
- A config-file path in code (`new File("config/league.yml")`) joins its file through `filePathReads`, not as a config key.
- A local initialized by a call that states no type (`val dao = Factory.getDAO()`) is stated as `localTypes[].from`; core types it through declared return types.
- Generated classes carry `ClassInfo.yieldsTo`; core's `dropYieldedClasses` ([../../../core/yielded-classes.ts](../../../core/yielded-classes.ts)) drops them where the same sub-project writes the class.
