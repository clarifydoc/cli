import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { swiftSpec } from "./index.js";
import { swiftPackages } from "./packages.js";
import { swiftManifest } from "./manifest.js";
import { swiftRequestSchema } from "./request-schema.js";
import { swiftReachability } from "./reachability.js";
import { SwiftEntityExtractor } from "./entities.js";
import { screenClassResolver } from "../shared/screen-classes.js";
import { storyboardNavigationResolver } from "./storyboard-navigation.js";

/** UIKit's screen classes: a view controller, by the platform classes a project's own derive from. */
const uikitScreenClasses = screenClassResolver("uikit-screen-classes", ["swift"], new Set([
  "UIViewController", "UITableViewController", "UICollectionViewController", "UIPageViewController",
  "UISplitViewController", "UITabBarController", "UIHostingController",
]));

const SWIFT_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Int8", "Int16", "Int32", "Int64",
  "UInt", "UInt8", "UInt16", "UInt32", "UInt64",
  "Float", "Double", "Bool", "Character",
  "String", "Substring",
  "Array", "Set", "Dictionary",
  "Optional", "Result",
  "Error", "Any", "AnyObject",
  "Void",
]);

export const swiftMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: swiftReachability,
  // Swift: `guard … else { … }` is an early exit, and `repeat { } while` is
  // its do-while.
  regexControlFlow: extendRegexControlFlow([
    { match: /^guard\b\s*(.*?)\s*else\s*\{?\s*$/, type: "if_statement" },
    { match: /^repeat\s*\{?\s*$/, type: "do_statement" },
  ], { quotes: ['"'] }),
  ...swiftManifest,
  docComments: C_STYLE_DOCS,
  regexSpec: swiftSpec,
  knownPackages: swiftPackages,
  builtinTypes: SWIFT_BUILTINS,
  requestSchema: swiftRequestSchema,
  // SwiftData @Model and Core Data NSManagedObject classes (see entities.ts).
  entities: new SwiftEntityExtractor(),
  // UIViewController subclasses are screens (shared/screen-classes.ts).
  routeResolvers: [uikitScreenClasses, storyboardNavigationResolver],
};
