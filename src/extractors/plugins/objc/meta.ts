import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { objcSpec } from "./index.js";
import { objcPackages } from "./packages.js";
import { objcManifest } from "./manifest.js";

const OBJC_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "id", "BOOL", "NSInteger", "NSUInteger", "CGFloat", "instancetype", "SEL", "Class", "IMP",
  "NSObject", "NSString", "NSMutableString", "NSNumber", "NSValue", "NSData", "NSMutableData",
  "NSArray", "NSMutableArray", "NSDictionary", "NSMutableDictionary", "NSSet", "NSMutableSet",
  "NSError", "NSDate", "NSURL", "NSURLRequest", "NSURLSession", "NSNotification",
  "UIView", "UIViewController", "UIColor", "UIImage", "UILabel", "UIButton", "UITableView",
  "CGRect", "CGSize", "CGPoint", "dispatch_queue_t",
]);

export const objcMeta: LanguagePluginMeta = {
  // Objective-C: `@try`/`@catch`/`@finally` carry a leading `@`.
  regexControlFlow: extendRegexControlFlow([
    { match: /^@try\b/, type: "try_statement" },
  ], { catch: /^\}?\s*@?catch\b/, finally: /^\}?\s*@?finally\b/ }),
  ...objcManifest,
  regexSpec: objcSpec,
  builtinTypes: OBJC_BUILTINS,
  knownPackages: objcPackages,
  apiCallRoots: ["AFHTTPSessionManager", "NSURLSession", "NSURLConnection"],
};
