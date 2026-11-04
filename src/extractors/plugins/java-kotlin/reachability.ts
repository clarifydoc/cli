import type { FileAnalysis } from "../../../types/analysis.js";
import { conventionReachability, typeLeaf, withPassive } from "../shared/reachability-kit.js";

/**
 * Java/Kotlin dead-code model. `import com.x.Foo` names a file
 * (`com/x/Foo.java`), but a class in the same package needs no import, so
 * types are also reached by name. A program starts at `main` or at what a
 * manifest declares — AndroidManifest components, `web.xml` servlets,
 * `META-INF/services` providers, layouts naming custom views. A servlet
 * container finds a `WebApplicationInitializer` on the classpath, and Glide's
 * annotation processor generates the code that loads a `@GlideModule`.
 * `@Suppress("unused")` / `@SuppressWarnings("unused")` is the author saying
 * it is reached in a way the compiler cannot see (reflection, a framework). What Spring,
 * Jakarta EE, Quarkus/Micronaut, Hilt and test runners discover by
 * annotation or base type is kept alive but anchors nothing — Camel loads its
 * `RouteBuilder`s, a JAX-WS runtime its `@WebService`s, Anvil merges its
 * `@Contributes*` classes into a component. A class a ProGuard/R8 keep rule
 * names is loaded by reflection, so shrinking must not remove it: kept alive
 * the same way, a package wildcard keeping every class of the package.
 */
export const javaKotlinReachability = conventionReachability({
  extensions: [".java", ".kt", ".kts"],
  importPath: (source) => (/^[A-Za-z_][\w.]*$/.test(source) ? source.replace(/\./g, "/") : null),
  names: {
    types: true,
    functions: true,
    stem: true,
    declaration: /\b(?:class|interface|enum|record|object|@interface)\s+([A-Za-z_]\w*)/g,
  },
  mainFunctions: /^main$/,
  routesAreEntries: true,
  entryDecorators:
    /^(?:SpringBootApplication|Component|Service|Repository|Controller|RestController|ControllerAdvice|RestControllerAdvice|Configuration|AutoConfiguration|Bean|Entity|Embeddable|MappedSuperclass|Converter|Aspect|WebServlet|WebFilter|WebListener|Path|Provider|ApplicationScoped|RequestScoped|SessionScoped|Singleton|Named|Dependent|Startup|QuarkusMain|MicronautApplication|Factory|Introspected|Module|InstallIn|HiltAndroidApp|AndroidEntryPoint|HiltViewModel|HiltWorker|Preview|Mapper|ConfigurationProperties|WebService|WebServiceProvider|ContributesBinding|ContributesMultibinding|ContributesTo|Scheduled|KafkaListener|RabbitListener|JmsListener|SqsListener|EventListener|StreamListener|ServerEndpoint|ClientEndpoint|Endpoint|Plugin|Mojo|AutoService|GlideModule|GlideExtension|Route|ShellComponent|Database|Dao|SpringBootTest|Test|Suppress(?:Warnings)?\([^)]*"unused)\b/,
  entryBaseTypes:
    /^(?:Activity|AppCompatActivity|ComponentActivity|FragmentActivity|Fragment|DialogFragment|BottomSheetDialogFragment|PreferenceFragmentCompat|Service|IntentService|LifecycleService|JobService|JobIntentService|FirebaseMessagingService|BroadcastReceiver|ContentProvider|Application|MultiDexApplication|Worker|CoroutineWorker|ListenableWorker|AccessibilityService|TileService|WallpaperService|InputMethodService|AppWidgetProvider|HttpServlet|GenericServlet|SpringBootServletInitializer|WebApplicationInitializer|AbstractAnnotationConfigDispatcherServletInitializer|AbstractDispatcherServletInitializer|AbstractSecurityWebApplicationInitializer|AppGlideModule|LibraryGlideModule|WebMvcConfigurer|ApplicationRunner|CommandLineRunner|ServletContextListener|AbstractMojo|DefaultTask|TestCase|RoomDatabase|RouteBuilder|EndpointRouteBuilder|SpringRouteBuilder|RouteConfigurationBuilder)$/,
  passiveFiles: [
    [/(?:^|\/)src\/(?:test|androidTest|testFixtures|integrationTest|it|jmh)\//, "test source set"],
    [/\.gradle\.kts$/, "Gradle build script"],
    [/(?:^|\/)buildSrc\//, "Gradle build logic"],
    [/(?:^|\/)db\/migration\//, "Flyway migration"],
  ],
  configFiles:
    /(?:^|\/)(?:AndroidManifest\.xml|src\/main\/res\/[^/]+\/[^/]+\.xml|web\.xml|[^/]*[Cc]ontext[^/]*\.xml|faces-config\.xml|persistence\.xml|plugin\.xml|META-INF\/services\/[^/]+|META-INF\/spring[^/]*|[^/]*\.factories|application[^/]*\.(?:properties|ya?ml))$/,
  async extend(_ctx, kit, base) {
    const keeps: RegExp[] = [];
    for (const rel of await kit.listFiles()) {
      if (!PROGUARD_FILE.test(rel)) continue;
      keeps.push(...proguardKeeps((await kit.readText(rel)) ?? ""));
    }
    if (keeps.length === 0) return {};
    return withPassive(base, (analysis) => (qualifiedNames(analysis).some((name) => keeps.some((k) => k.test(name))) ? "kept by a ProGuard rule" : null));
  },
});

/** ProGuard/R8 configuration: `proguard-rules.pro`, `consumer-rules.pro`, `proguard.cfg`, `r8-rules.pro`. */
const PROGUARD_FILE = /(?:^|\/)(?:[^/]*proguard[^/]*\.(?:pro|cfg|txt)|consumer-rules\.pro|[^/]*r8[^/]*\.pro)$/i;

/**
 * The class-name patterns of the rules that keep a CLASS: `-keep`, `-keepnames`,
 * `-keepclasseswithmembers`, `-keepclasseswithmembernames` — not
 * `-keepclassmembers` (members of a class kept otherwise), not `allowshrinking`.
 * A pattern must start with a package or class name: `class *` and `**.R` name no
 * class of their own. Each becomes a regex over a dotted name: `**` any
 * packages, `*` one name, `?` one character; `Club$*` keeps `Club`.
 */
export function proguardKeeps(text: string): RegExp[] {
  const out: RegExp[] = [];
  const body = text.replace(/#.*$/gm, "");
  const rule = /(?:^|\s)-keep(?:names|classeswithmembers|classeswithmembernames)?((?:\s*,\s*\w+)*)\s+([^{\n-][^{\n]*)/g;
  for (const m of body.matchAll(rule)) {
    if (/allowshrinking/i.test(m[1] ?? "")) continue;
    const spec = /\b(?:class|interface|enum)\s+([^\s{]+(?:\s*,\s*[^\s{]+)*)/.exec(m[2] ?? "");
    if (!spec) continue;
    for (const raw of spec[1]!.split(",")) {
      const name = raw.trim().replace(/\$.*$/, "");
      if (!/^[A-Za-z_][\w]*\./.test(name)) continue;
      const pattern = name
        .split(/(\*\*|\*|\?|<\d+>)/)
        .map((part) =>
          part === "**" ? ".*" : part === "*" || /^<\d+>$/.test(part) ? "[^.]*" : part === "?" ? "[^.]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      out.push(new RegExp(`(?:^|\\.)${pattern}$`));
    }
  }
  return out;
}

/** Dotted names a file's classes may go by: its directories as packages, then the class or the file stem. */
function qualifiedNames(analysis: FileAnalysis): string[] {
  const path = analysis.filePath.replace(/\.[^./]+$/, "");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")).replace(/\//g, ".") : "";
  const prefix = dir ? `${dir}.` : "";
  return [path.replace(/\//g, "."), ...analysis.classes.map((c) => prefix + typeLeaf(c.name))];
}
