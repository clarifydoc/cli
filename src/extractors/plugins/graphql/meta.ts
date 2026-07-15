import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { graphqlSpec } from "./index.js";
import { graphqlManifest } from "./manifest.js";

/**
 * GraphQL schema (`.graphql`/`.gql`). A declarative contract, not code — the
 * `.graphql` extension is unambiguous, so no content sniff is needed. Security
 * scanning is skipped (no executable code to flag).
 */
export const graphqlMeta: LanguagePluginMeta = {
  ...graphqlManifest,
  regexSpec: graphqlSpec,
  skipSecurityScan: true,
};
