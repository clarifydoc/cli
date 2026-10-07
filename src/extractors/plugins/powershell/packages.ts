import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** PowerShell Gallery module recognition. */
export const psgalleryPackages: readonly KnownPackageRule[] = [
  { names: ["Pode"], category: "framework", framework: { id: "pode", name: "Pode" } },
  { names: ["Polaris"], category: "framework", framework: { id: "polaris", name: "Polaris" } },
  { names: ["Pester", "PSScriptAnalyzer"], category: "testing" },
  { names: ["SqlServer", "dbatools", "PSSQLite", "SimplySql"], category: "database" },
  { match: /^az(\.|$)|^aws\.tools\.|^awspowershell/i, category: "cloud" },
  { names: ["PSFramework", "PSLogging"], category: "logging" },
];
