import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of the GraphQL schema plugin (`.graphql`/`.gql`/`.graphqls`). */
export const graphqlManifest: LanguagePluginManifest = {
  language: "graphql",
  parsing: "regex",
  extensions: [".graphql", ".gql", ".graphqls"],
  apiContract: true,
  importTarget: false,
};
