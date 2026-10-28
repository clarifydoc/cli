/**
 * Single-file C and C++ libraries copied into a source tree, known by the
 * banner each release writes at its top — never by its path, which is
 * wherever the project put it (`src/json.hpp`, `deps/sqlite3.c`). A leaf
 * module: the C and C++ manifests list it as their `vendoredBanners`.
 */
export const C_FAMILY_LIBRARY_BANNERS: ReadonlyArray<{ library: string; banner: RegExp }> = [
  { library: "SQLite", banner: /\bThis file is an amalgamation of many separate C source files from SQLite\b/ },
  { library: "SQLite", banner: /\bThis header file defines the (?:interface that the SQLite library|SQLite interface for use by shared libraries)\b/ },
  { library: "nlohmann/json", banner: /\bJSON for Modern C\+\+/ },
  { library: "stb", banner: /\bstb_\w+(?:\.h)?\s+-\s+v\d+\.\d+\w*\s+-\s+public domain\b/ },
  { library: "miniz", banner: /\bminiz\.[ch]\s+v?\d+(?:\.\d+)*\w*\s+-\s+public domain\b/ },
  { library: "Zstandard", banner: /\bSingle-file Zstandard (?:library|decompressor)\b/ },
  { library: "xxHash", banner: /\bxxHash - Extremely Fast Hash algorithm\b/ },
  { library: "LZ4", banner: /\bLZ4 - Fast LZ compression algorithm\b/ },
  { library: "Dear ImGui", banner: /\bdear imgui,? v\d/ },
  { library: "doctest", banner: /\bdoctest\.h - the lightest feature-rich C\+\+ single-header testing framework\b/ },
  { library: "Catch2", banner: /\bCatch v\d+\.\d+\.\d+\s*\n\s*\*\s*Generated: \d{4}-\d\d-\d\d/ },
  { library: "cJSON", banner: /\bDave Gamble and cJSON contributors\b/ },
];
