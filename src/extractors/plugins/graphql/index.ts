import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractGraphqlEntities, extractGraphqlRelations, extractGraphqlRoutes } from "../shared/graphql-sdl.js";
import { extractGqlDocumentCalls } from "../shared/graphql-operations.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

export * from "../shared/graphql-sdl.js";

/**
 * GraphQL files: a schema (`.graphql`/`.gql`, Spring's `.graphqls`) gives
 * routes and entities (see shared/graphql-sdl.ts); an operation document a
 * client keeps beside its code (`query GetUser { user(id: 1) { … } }`,
 * read by codegen) gives one api-call per root field, as an inline `gql`
 * template does.
 */
export const graphqlSpec: RegexLangSpec = {
  language: "graphql",
  extensions: [".graphql", ".gql", ".graphqls"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["#"],
  extractRoutes: (lines) => extractGraphqlRoutes(lines),
  extractClasses: (lines) => extractGraphqlEntities(lines),
  extractEntityRelations: (lines, classes) => extractGraphqlRelations(lines, classes),
  extractDataSources: (lines): DataSourceInfo[] => extractGqlDocumentCalls(lines.join("\n")),
};
