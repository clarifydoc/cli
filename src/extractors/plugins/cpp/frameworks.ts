import type { FrameworkRule } from "../../../types/language-plugin.js";

/**
 * Qt (C++ desktop) — find_package(Qt5/Qt6 …) in the root CMakeLists, or
 * qmake project files alongside C++ sources. The QML-specific `qt-quick`
 * rule lives with the qml plugin.
 */
export const cppFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "qt",
    name: "Qt",
    check: (info) =>
      (!!info.cmakeLists && /find_package\s*\(\s*Qt[456]?/i.test(info.cmakeLists)) ||
      info.fileExtensions.has(".qml") ||
      info.fileExtensions.has(".pro"),
    detectedVia: "CMakeLists find_package / .qml files",
  },
];
