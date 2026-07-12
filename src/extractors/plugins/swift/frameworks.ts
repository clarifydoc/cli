import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasSwiftPackage } from "../shared/project-info-queries.js";

/** Swift server framework rules via Package.swift. */
export const swiftFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "vapor",
    name: "Vapor",
    check: (info) => hasSwiftPackage(info, "vapor"),
    detectedVia: "Package.swift dependency",
  },
  {
    id: "fluent",
    name: "Fluent",
    check: (info) => hasSwiftPackage(info, "fluent"),
    detectedVia: "Package.swift dependency",
  },
];
