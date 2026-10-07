import { conventionReachability } from "./reachability-kit.js";

/**
 * C, C++ and Objective-C dead-code model — ONE instance shared by the three
 * plugins (headers belong to C++, sources to each language, and an include
 * crosses them). `#include "x.h"` / `#import` name files, resolved beside the
 * includer and then anywhere the path ends that way; across translation
 * units functions and types are reached by NAME (a `.c` file whose functions
 * nobody calls is not linked into anything that runs). Entries: `main` and
 * friends, Arduino sketches, UIKit/AppKit classes a storyboard names.
 */
export const cFamilyReachability = conventionReachability({
  extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".inl", ".ino", ".m", ".mm", ".cu", ".cuh"],
  importPath: (source) => (/^[\w./+-]+$/.test(source) ? source : null),
  names: {
    types: true,
    functions: true,
    stem: true,
    declaration: /(?:\b(?:class|struct|union|enum(?:\s+class)?)|@(?:interface|implementation|protocol))\s+([A-Za-z_]\w*)/g,
  },
  mainFunctions: /^(?:main|wmain|WinMain|wWinMain|_tmain|DllMain|setup|loop|app_main|android_main)$/,
  entryFiles: [[/\.ino$/, "Arduino sketch"]],
  passiveFiles: [[/(?:^|\/)(?:third_party|thirdparty|external|extern)\//, "vendored library"]],
  entryBaseTypes:
    /^(?:UIViewController|UITableViewController|UICollectionViewController|UIView|UITableViewCell|UIResponder|UIApplicationDelegate|NSApplicationDelegate|NSViewController|NSWindowController|XCTestCase)$/,
  configFiles: /\.(?:storyboard|xib|plist|qrc)$/,
});
