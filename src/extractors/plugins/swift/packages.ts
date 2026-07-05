import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Swift package recognition (SwiftPM + CocoaPods; classified by name). */
export const swiftPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["Vapor", "vapor"], category: "framework", framework: { id: "vapor", name: "Vapor" } },
  { names: ["Kitura"], category: "framework", framework: { id: "kitura", name: "Kitura" } },
  { names: ["Perfect"], category: "framework", framework: { id: "perfect", name: "Perfect" } },
  // ── HTTP ──
  { names: ["Alamofire", "Moya"], category: "http" },
  // ── State / reactive ──
  { names: ["RxSwift", "RxCocoa", "ComposableArchitecture"], category: "state" },
  // ── UI ──
  { names: ["SnapKit", "Kingfisher", "SDWebImage", "Lottie", "SwiftUIX"], category: "ui" },
  // ── Database / persistence ──
  { names: ["Realm", "RealmSwift", "GRDB", "GRDB.swift", "SQLite.swift"], category: "database" },
  // ── Serialization ──
  { names: ["SwiftyJSON"], category: "serialization" },
  // ── Logging ──
  { names: ["swift-log", "CocoaLumberjack"], category: "logging" },
  // ── Testing ──
  { names: ["Quick", "Nimble"], category: "testing" },
  // ── DI / utility ──
  { names: ["Swinject"], category: "util" },
];
