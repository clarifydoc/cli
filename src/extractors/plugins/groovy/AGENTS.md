# Groovy plugin

Reads `.groovy`/`.gvy`/`.gy`/`.gsh` and `Jenkinsfile` through the regex path (`family: "jvm"`): `tree-sitter-groovy` left 56% of real code in ERROR nodes, so there is no tree-sitter reader.

- Frameworks read ([frameworks.ts](frameworks.ts), [routes.ts](routes.ts)): Grails UrlMappings and controller conventions (a handler named `Class.method` binds only to that class's method), GORM ([entities.ts](entities.ts), [data-sources.ts](data-sources.ts)), Spring and Micronaut annotations, Spock tests.
- Reachability: [reachability.ts](reachability.ts).
