import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Scala dead-code model: Java's shape (imports name files, a package's types
 * are reached by name), with Play's `conf/routes` and module configuration,
 * `App`/`IOApp` objects and Akka actors as entries.
 */
export const scalaReachability = conventionReachability({
  extensions: [".scala", ".sc"],
  importPath: (source) => (/^[A-Za-z_][\w.]*$/.test(source) ? source.replace(/\./g, "/") : null),
  names: {
    types: true,
    functions: true,
    stem: true,
    declaration: /\b(?:class|trait|object|enum)\s+([A-Za-z_]\w*)/g,
  },
  mainFunctions: /^main$/,
  routesAreEntries: true,
  entryFiles: [
    [/(?:^|\/)conf\/routes$/, "Play routes"],
    [/\.sc$/, "Scala script"],
  ],
  passiveFiles: [[/(?:^|\/)project\/[^/]+\.scala$/, "sbt build definition"]],
  entryBaseTypes:
    /^(?:App|IOApp|ZIOAppDefault|ZIOApp|AbstractController|BaseController|InjectedController|Controller|Actor|AbstractActor|Module|AbstractModule|Filter|EssentialFilter|HttpErrorHandler|ApplicationLoader|BuiltInComponentsFromContext|AutoPlugin|Specification|FunSuite|AnyFunSuite|AnyFlatSpec|AnyWordSpec|AnyFreeSpec|PlaySpec)$/,
  configFiles: /(?:^|\/)(?:conf\/[^/]+\.conf|application\.conf|reference\.conf|[^/]+\.sbt)$/,
});
