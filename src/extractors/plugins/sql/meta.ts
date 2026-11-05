import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { sqlSpec } from "./index.js";
import { sqlManifest } from "./manifest.js";
import { SqlMigrationEntities } from "./entities.js";
import { StoredRoutineResolver } from "./routine-dispatch.js";
import { dbtPreprocess } from "./dbt.js";

export const sqlMeta: LanguagePluginMeta = {
  ...sqlManifest,
  regexSpec: sqlSpec,
  // A dbt model: Jinja around one SELECT, a table built from the models and sources it names.
  preprocess: dbtPreprocess,
  // CREATE / ALTER / DROP per file, and a versioned migration chain replayed into one schema.
  entities: new SqlMigrationEntities(),
  // A stored procedure called by name from any language → the routine a script declares.
  dispatchResolvers: [new StoredRoutineResolver()],
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
