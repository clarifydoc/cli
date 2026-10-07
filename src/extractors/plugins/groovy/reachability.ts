import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Groovy dead-code model: Java's shape — `import a.b.C` names `a/b/C.groovy`,
 * a package's types are reached by name — plus Grails, which loads everything
 * under `grails-app/` by convention (controllers, services, domain classes,
 * tag libs, jobs, `BootStrap`, `UrlMappings`): kept alive, never reported, and
 * anchoring nothing. Spring / Micronaut components are found by annotation.
 */
export const groovyReachability = conventionReachability({
  extensions: [".groovy", ".gvy", ".gy", ".gsh"],
  importPath: (source) => (/^[A-Za-z_][\w.]*$/.test(source) ? source.replace(/\./g, "/") : null),
  names: {
    types: true,
    functions: true,
    stem: true,
    declaration: /\b(?:class|interface|trait|enum|record|@interface)\s+([A-Za-z_]\w*)/g,
  },
  mainFunctions: /^main$/,
  routesAreEntries: true,
  entryFiles: [
    [/(?:^|\/)grails-app\/init\/.+\/Application\.groovy$/, "Grails application"],
    [/(?:^|\/)(?:scripts|bin)\/[^/]+\.(?:groovy|gvy|gy|gsh)$/, "Groovy script"],
  ],
  passiveFiles: [
    [/(?:^|\/)src\/(?:test|integration-test|testFixtures)\//, "test source set"],
    [/(?:^|\/)buildSrc\//, "Gradle build logic"],
  ],
  frameworkPassive: {
    grails: [[/(?:^|\/)grails-app\//, "loaded by Grails by convention"]],
  },
  entryDecorators:
    /^(?:SpringBootApplication|Component|Service|Repository|Controller|RestController|ControllerAdvice|Configuration|Bean|Entity|Singleton|Factory|Requires|Context|Scheduled|EventListener|KafkaListener|RabbitListener|Grab|CompileStatic)\b/,
  entryBaseTypes: /^(?:Specification|Script|GroovyTestCase|TestCase|Plugin|DefaultTask|HttpServlet)$/,
  configFiles: /(?:^|\/)(?:application[^/]*\.(?:ya?ml|groovy|properties)|[^/]+\.gradle|META-INF\/services\/[^/]+)$/,
});
