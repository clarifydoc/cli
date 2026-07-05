import type { KnownPackageRule } from "../../../types/language-plugin.js";

/**
 * Objective-C CocoaPods libraries (matched by name; shared SwiftPM/CocoaPods
 * names like SDWebImage already live in the swift plugin's table and resolve via
 * the registry's global map).
 */
export const objcPackages: readonly KnownPackageRule[] = [
  { names: ["AFNetworking", "AFNetworking2"], category: "http" },
  { names: ["Masonry", "PureLayout"], category: "ui" },
  { names: ["MBProgressHUD", "SVProgressHUD", "IQKeyboardManager"], category: "ui" },
  { names: ["FMDB"], category: "database" },
  { names: ["Mantle", "JSONModel"], category: "serialization" },
  { names: ["Reachability"], category: "util" },
  { names: ["OCMock", "Kiwi", "Specta", "Expecta"], category: "testing" },
];
