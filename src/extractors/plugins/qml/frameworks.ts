import type { FrameworkRule } from "../../../types/language-plugin.js";

/** Qt Quick — QML files present (the broader `qt` rule lives with the cpp plugin). */
export const qmlFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "qt-quick",
    name: "Qt Quick (QML)",
    check: (info) => info.fileExtensions.has(".qml"),
    detectedVia: ".qml files",
  },
];
