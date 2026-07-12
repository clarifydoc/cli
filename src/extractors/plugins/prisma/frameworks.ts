import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasDep } from "../shared/project-info-queries.js";

/** Prisma — an npm dependency, but the prisma plugin owns the domain. */
export const prismaFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "prisma",
    name: "Prisma",
    check: (info) => hasDep(info, "prisma") || hasDep(info, "@prisma/client"),
    detectedVia: "package.json dependency",
  },
];
