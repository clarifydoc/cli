import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasPubspecDep } from "../shared/project-info-queries.js";

/** Dart / Flutter framework rules via pubspec.yaml. */
export const dartFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "flutter",
    name: "Flutter",
    check: (info) => hasPubspecDep(info, "flutter"),
    detectedVia: "pubspec.yaml dependency",
  },
  {
    id: "shelf",
    name: "Shelf",
    check: (info) => hasPubspecDep(info, "shelf") || hasPubspecDep(info, "shelf_router"),
    detectedVia: "pubspec.yaml dependency",
  },
  {
    id: "dart_frog",
    name: "Dart Frog",
    check: (info) => hasPubspecDep(info, "dart_frog"),
    detectedVia: "pubspec.yaml dependency",
  },
];
