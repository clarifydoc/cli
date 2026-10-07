import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * PowerShell dead-code model. A `.ps1` script is run by a person, a
 * scheduler or CI — never reported, and it anchors nothing (a repo of
 * scripts is not one program). A `.psm1` module is reached through
 * `Import-Module` / dot-sourcing (paths and module names), through the
 * functions it declares being called by name anywhere reachable (commands are
 * looked up by name), or by its manifest (`RootModule`, `NestedModules`,
 * `FunctionsToExport` in a `.psd1`).
 */
export const powershellReachability = conventionReachability({
  extensions: [".ps1", ".psm1"],
  caseInsensitive: true,
  importPath: (source) => (/^\.{1,2}\//.test(source) ? source : /^[A-Za-z][\w.]*$/.test(source) ? source : null),
  names: { functions: true, types: true, stem: true },
  passiveFiles: [
    [/\.Tests\.ps1$/i, "Pester test"],
    [/\.ps1$/i, "PowerShell script"],
  ],
  configFiles: /\.psd1$/i,
});
