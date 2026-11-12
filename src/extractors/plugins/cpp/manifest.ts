import { cppCollectionElement } from "./collection-element.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { C_FAMILY_LIBRARY_BANNERS } from "../shared/c-family-libraries.js";
import { cppFrameworkRules } from "./frameworks.js";
import { vcpkgPackageManager, conanPackageManager } from "./package-manifests.js";
import { parseCompileCommands } from "../shared/compile-commands.js";
import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
/** The C++ source extensions: a project with one of these reads its `.h` as C++ first. `.mm` is Objective-C++. */
const CPP_SOURCE_EXTENSIONS = [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".cu", ".cuh", ".mm"];

/**
 * A `.h` belongs to this plugin whatever language includes it. In a sub-project that holds C sources and no C++ ones
 * its headers are C, so the C grammar reads them first (variant `c-first`; C++'s grammar stays the fallback). A
 * project with no `.c` file, or any C++ source, keeps the default: C++ first. See `readCpp`.
 */
export function cppReadingVariant(relativePath: string, mix: Readonly<Record<string, number>>): string | undefined {
  if (!/\.h$/i.test(relativePath)) return undefined;
  if (!mix[".c"]) return undefined;
  return CPP_SOURCE_EXTENSIONS.some((ext) => mix[ext]) ? undefined : "c-first";
}

/**
 * The element types a `std::pair<Club, Player>` / `std::tuple<…>` return states, in order, for a structured binding
 * (`auto [club, player] = pairOf();`). A map's key and value type are the same two positions (an iterator over it
 * reads `it->first` and `it->second` there). Null for any other type.
 */
export function cppTupleElements(returnType: string): string[] | null {
  const m = /^(?:const\s+)?(?:std\s*::\s*)?(?:pair|tuple|map|multimap|unordered_map|unordered_multimap)\s*<([\s\S]+)>\s*[&]*$/.exec(returnType.trim());
  if (!m) return null;
  const isMap = /(?:map)\s*</.test(returnType.slice(0, returnType.indexOf("<") + 1));
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const body = m[1]!;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;
    else if ((ch === "," && depth === 0) || i === body.length) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out.every(Boolean) ? (isMap ? out.slice(0, 2) : out) : null;
}

export const cppManifest: LanguagePluginManifest = {
  tupleElementsOf: cppTupleElements,
  bindsStructFields: true,
  docComments: C_STYLE_DOCS,
  language: "cpp",
  collectionElementOf: cppCollectionElement,
  family: "cfam",
  packageManagers: [vcpkgPackageManager, conanPackageManager],
  packageEcosystems: ["vcpkg", "conan"],
  parsing: "regex",
  // `.cu` / `.cuh`: CUDA — C++ plus kernel qualifiers and `<<<…>>>` launches (see index.ts).
  extensions: [".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".cu", ".cuh"],
  vendoredBanners: C_FAMILY_LIBRARY_BANNERS,
  // `#include "helpers.h"` puts what the header declares in scope; `helpers.cc` holds the bodies.
  // `compile_commands.json`: per file the include directories an `#include` searches and the `-D` macros.
  compilationDatabase: { files: ["compile_commands.json", "build/compile_commands.json"], parse: parseCompileCommands },
  importsShareScope: true,
  declarationExtensions: [".h", ".hpp", ".hxx", ".hh", ".cuh"],
  // One type spans files here: member functions are defined out of line in a `.cpp` beside the header.
  typesSpanFiles: true,
  // `class Sedan : public Chassis, public Engine`: bases are classes, searched in order.
  multipleInheritance: true,
  // A body that reads as a free function may be a member: `TEST_F(GarageTest, Parks) { OpenBay(3); }` is a
  // method of a fixture subclass the macro declares, and `(*it)->kick()` still loses its receiver. So a bare
  // call may be another class's member.
  bareCallsHideReceivers: true,
  frameworkRules: cppFrameworkRules,
  activationFiles: ["CMakeLists.txt", "conanfile.txt", "vcpkg.json"],
  readingVariant: cppReadingVariant,
};
