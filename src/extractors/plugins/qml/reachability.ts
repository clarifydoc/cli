import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * QML dead-code model. A component is its file name, used as a type
 * (`UserCard { }`) — a name reference, from QML or from C++ (`qrc:/Main.qml`).
 * Resource and build files that list every QML source are deliberately not
 * read: being compiled in is not being used.
 */
export const qmlReachability = conventionReachability({
  extensions: [".qml"],
  names: { stem: true },
  entryFiles: [[/(?:^|\/)main\.qml$/i, "QML entry"]],
});
