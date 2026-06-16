import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { prismaSpec } from "./index.js";

/**
 * Prisma schema files (`schema.prisma`). Parsed by the dedicated regex spec;
 * `importTarget: false` keeps the `.prisma` basename out of import-path maps so
 * it never collides with a `*.ts` of the same name.
 */
export const prismaMeta: LanguagePluginMeta = {
  language: "prisma",
  parsing: "regex",
  extensions: prismaSpec.extensions,
  regexSpec: prismaSpec,
  importTarget: false,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
