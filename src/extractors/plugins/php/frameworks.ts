import { existsSync } from "fs";
import { join } from "path";
import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasComposerDep } from "../shared/project-info-queries.js";

/**
 * CodeIgniter 2/3 ships its framework as a checked-in `system/` tree beside
 * the `application/` dir — no composer manifest records it, so its presence is
 * only visible in the file layout. Declared as a marker candidate (collected
 * into `ProjectInfo.markerFiles`); composer-era CI4 is covered by knownPackages.
 */
export const phpMarkerCandidates: readonly string[] = [
  "system/core/CodeIgniter.php",
];

/** PHP framework rules — vendored CodeIgniter, composer-era frameworks, and ORMs. */
export const phpFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "codeigniter",
    name: "CodeIgniter",
    check: (info) => info.markerFiles.includes("system/core/CodeIgniter.php"),
    detectedVia: "vendored system/core/CodeIgniter.php",
  },
  {
    id: "laravel",
    name: "Laravel",
    check: (info) =>
      hasComposerDep(info, "laravel/framework") ||
      hasComposerDep(info, "laravel/lumen-framework") ||
      existsSync(join(info.root, "artisan")),
    detectedVia: "composer.json dependency / artisan file",
  },
  {
    id: "symfony",
    name: "Symfony",
    check: (info) =>
      hasComposerDep(info, "symfony/framework-bundle") ||
      hasComposerDep(info, "symfony/http-kernel"),
    detectedVia: "composer.json dependency",
  },
  // ORMs
  {
    id: "doctrine",
    name: "Doctrine ORM",
    check: (info) => hasComposerDep(info, "doctrine/orm") || hasComposerDep(info, "doctrine/dbal"),
    detectedVia: "composer.json dependency",
  },
  {
    id: "eloquent",
    name: "Eloquent",
    check: (info) => hasComposerDep(info, "illuminate/database") || hasComposerDep(info, "laravel/framework"),
    detectedVia: "composer.json dependency",
  },
];
