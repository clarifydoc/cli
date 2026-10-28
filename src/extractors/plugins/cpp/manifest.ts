import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { C_FAMILY_LIBRARY_BANNERS } from "../shared/c-family-libraries.js";
import { cppFrameworkRules } from "./frameworks.js";
import { vcpkgPackageManager, conanPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const cppManifest: LanguagePluginManifest = {
  language: "cpp",
  family: "cfam",
  packageManagers: [vcpkgPackageManager, conanPackageManager],
  packageEcosystems: ["vcpkg", "conan"],
  parsing: "regex",
  // `.cu` / `.cuh`: CUDA — C++ plus kernel qualifiers and `<<<…>>>` launches (see index.ts).
  extensions: [".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".cu", ".cuh"],
  vendoredBanners: C_FAMILY_LIBRARY_BANNERS,
  // One type spans files here: member functions are defined out of line in a `.cpp` beside the header.
  typesSpanFiles: true,
  frameworkRules: cppFrameworkRules,
  activationFiles: ["CMakeLists.txt", "conanfile.txt", "vcpkg.json"],
};
