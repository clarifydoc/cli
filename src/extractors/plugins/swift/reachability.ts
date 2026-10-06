import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Swift dead-code model. Everything in a module sees everything else without
 * an import, so types and functions are reached by name (an `extension Foo`
 * file is reached whenever `Foo` is). Entries: `@main`/`main.swift`, Vapor's
 * app wiring, UIKit/AppKit classes a storyboard instantiates by class name
 * (storyboards and xibs are scanned too), commands and migrations.
 */
export const swiftReachability = conventionReachability({
  extensions: [".swift"],
  names: {
    types: true,
    functions: true,
    stem: true,
    declaration: /\b(?:class|struct|enum|protocol|actor|extension)\s+([A-Za-z_]\w*)/g,
  },
  entrySource: [[/@main\b|@UIApplicationMain|@NSApplicationMain/, "program entry (@main)"]],
  entryFiles: [
    [/(?:^|\/)main\.swift$/, "program entry (main.swift)"],
    [/(?:^|\/)(?:configure|routes|entrypoint|boot)\.swift$/, "Vapor app wiring"],
  ],
  passiveFiles: [
    [/(?:^|\/)Package\.swift$/, "Swift package manifest"],
    [/(?:^|\/)Tests\//, "test target"],
  ],
  // `public`/`open` is a library product's API, used from other modules.
  passiveSource: [[/\b(?:public|open)\s+(?:final\s+)?(?:class|struct|enum|protocol|actor|func|extension|typealias)\b/, "public API"]],
  entryBaseTypes:
    /^(?:App|UIApplicationDelegate|UIWindowSceneDelegate|NSApplicationDelegate|UIViewController|UITableViewController|UICollectionViewController|UINavigationController|UITabBarController|UIPageViewController|UISplitViewController|UIView|UITableViewCell|UICollectionViewCell|UICollectionReusableView|NSViewController|NSWindowController|NSView|NSDocument|XCTestCase|AsyncCommand|Command|ParsableCommand|AsyncParsableCommand|Migration|AsyncMigration|LifecycleHandler|Widget|WidgetBundle|PreviewProvider|INExtension|UNNotificationServiceExtension)$/,
  configFiles: /\.(?:storyboard|xib|plist|entitlements|xcscheme)$|\.xcdatamodel\/contents$/,
});
