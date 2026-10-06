import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Java/Kotlin dead-code model. `import com.x.Foo` names a file
 * (`com/x/Foo.java`), but a class in the same package needs no import, so
 * types are also reached by name. A program starts at `main` or at what a
 * manifest declares — AndroidManifest components, `web.xml` servlets,
 * `META-INF/services` providers, layouts naming custom views. What Spring,
 * Jakarta EE, Quarkus/Micronaut, Hilt and test runners discover by
 * annotation or base type is kept alive but anchors nothing.
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
    /^(?:SpringBootApplication|Component|Service|Repository|Controller|RestController|ControllerAdvice|RestControllerAdvice|Configuration|AutoConfiguration|Bean|Entity|Embeddable|MappedSuperclass|Converter|Aspect|WebServlet|WebFilter|WebListener|Path|Provider|ApplicationScoped|RequestScoped|SessionScoped|Singleton|Named|Dependent|Startup|QuarkusMain|MicronautApplication|Factory|Introspected|Module|InstallIn|HiltAndroidApp|AndroidEntryPoint|HiltViewModel|HiltWorker|Preview|Mapper|ConfigurationProperties|Scheduled|KafkaListener|RabbitListener|JmsListener|SqsListener|EventListener|StreamListener|ServerEndpoint|ClientEndpoint|Endpoint|Plugin|Mojo|AutoService|Route|ShellComponent|Database|Dao|SpringBootTest|Test)\b/,
  entryBaseTypes:
    /^(?:Activity|AppCompatActivity|ComponentActivity|FragmentActivity|Fragment|DialogFragment|BottomSheetDialogFragment|PreferenceFragmentCompat|Service|IntentService|LifecycleService|JobService|JobIntentService|FirebaseMessagingService|BroadcastReceiver|ContentProvider|Application|MultiDexApplication|Worker|CoroutineWorker|ListenableWorker|AccessibilityService|TileService|WallpaperService|InputMethodService|AppWidgetProvider|HttpServlet|GenericServlet|SpringBootServletInitializer|WebMvcConfigurer|ApplicationRunner|CommandLineRunner|ServletContextListener|AbstractMojo|DefaultTask|TestCase|RoomDatabase)$/,
  passiveFiles: [
    [/(?:^|\/)src\/(?:test|androidTest|testFixtures|integrationTest|it|jmh)\//, "test source set"],
    [/\.gradle\.kts$/, "Gradle build script"],
    [/(?:^|\/)buildSrc\//, "Gradle build logic"],
    [/(?:^|\/)db\/migration\//, "Flyway migration"],
  ],
  configFiles:
    /(?:^|\/)(?:AndroidManifest\.xml|src\/main\/res\/[^/]+\/[^/]+\.xml|web\.xml|[^/]*[Cc]ontext[^/]*\.xml|faces-config\.xml|persistence\.xml|plugin\.xml|META-INF\/services\/[^/]+|META-INF\/spring[^/]*|[^/]*\.factories|application[^/]*\.(?:properties|ya?ml))$/,
});
