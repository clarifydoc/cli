import type { FrameworkRule } from "../../../types/language-plugin.js";

/** Raw SQL — surfaced when *.sql / *.ddl files exist. */
export const sqlFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "sql",
    name: "SQL",
    check: (info) => info.sqlFiles.length > 0,
    detectedVia: ".sql / .ddl files",
  },
];
