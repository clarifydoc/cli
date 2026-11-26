import { cppCollectionElement } from "./collection-element.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { C_FAMILY_LIBRARY_BANNERS } from "../shared/c-family-libraries.js";
import { cppFrameworkRules } from "./frameworks.js";
import { vcpkgPackageManager, conanPackageManager } from "./package-manifests.js";
import { parseCompileCommands } from "../shared/compile-commands.js";
import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";
import { cmakeProjectCommands, ctestCommand } from "../shared/cmake-commands.js";
import { declaresCmakeProject } from "./project-markers.js";

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
  testCommand: ctestCommand,
  projectCommands: cmakeProjectCommands,
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
  // Per translation unit the `-iquote`/`-I`/`-isystem` directories and `-D`/`-U` macros (`core/compilation-database.ts`;
  // paths a CI wrote are matched by their longest tail). `placeIncludes` rewrites an include to the file the compiler's
  // search order finds first, in memory only; a file compiled twice with different results, and headers, keep the
  // generic rules. `macrosOf` (the macros every unit agrees on) goes to the parser front end and is stamped into the
  // incremental `resolver`; `preprocessor-branches.ts` picks the live arm of `#ifdef` / `#if defined()` only for macros
  // whose state is known.
  compilationDatabase: { files: ["compile_commands.json", "build/compile_commands.json"], parse: parseCompileCommands },
  // A bare call the file does not define resolves to the ONE included file that does (`import-file`); where that file
  // is a header (`declarationExtensions`) the files sharing its stem define what it declares, a `static` body never.
  // An include's stem is no binding (`importedBinding`). An include naming a file with its extension resolves to the
  // file of exactly that name: from the project root when written without `./`, then beside the importer, then the one
  // file whose path ends with it (`uniquePathEnding`), then the one path suffix that matches; two files spelling it
  // alike stay unresolved. A body file with a declaration file of its own stem beside it defines only that file's names.
  importsShareScope: true,
  declarationExtensions: [".h", ".hpp", ".hxx", ".hh", ".cuh"],
  // One type spans files here: member functions are defined out of line in a `.cpp` beside the header.
  // A member defined out of line in another file (`methodBesideClass`) answers a class its caller's header declares only
  // when that file's own includes do not reach a different declaration of the class; two headers declaring one class
  // name are told apart by the caller's own declaration, then the include closure, and refused when neither decides
  // (`pickDefinition`, `typeFileFor`).
  typesSpanFiles: true,
  // A type declared in another directory's header (reached by `#include`) answers a typed write (member effects look it up beyond the writer's directory).
  typesBeyondDirectory: true,
  // `class Sedan : public Chassis, public Engine`: bases are classes, searched in order.
  multipleInheritance: true,
  // A body that reads as a free function may be a member: `TEST_F(GarageTest, Parks) { OpenBay(3); }` is a
  // method of a fixture subclass the macro declares, and `(*it)->kick()` still loses its receiver. So a bare
  // call may be another class's member. Inside a method a bare call is otherwise the caller's own class's member, then
  // its bases', never another class's of the same file.
  bareCallsHideReceivers: true,
  frameworkRules: cppFrameworkRules,
  activationFiles: ["CMakeLists.txt", "conanfile.txt", "vcpkg.json"],
  readingVariant: cppReadingVariant,
  // Files that mark a sub-project root (core's project detector); a lower `priority` wins a directory holding several kinds.
  projectMarkers: [
    { pattern: "**/CMakeLists.txt", kind: "cmake", priority: 110, isProjectRoot: declaresCmakeProject },
  ],
};
