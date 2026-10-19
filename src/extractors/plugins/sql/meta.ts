import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { sqlSpec } from "./index.js";
import { sqlManifest } from "./manifest.js";
import { SqlMigrationEntities } from "./entities.js";

export const sqlMeta: LanguagePluginMeta = {
  ...sqlManifest,
  regexSpec: sqlSpec,
  // CREATE / ALTER / DROP per file, and a versioned migration chain replayed into one schema.
  entities: new SqlMigrationEntities(),
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
