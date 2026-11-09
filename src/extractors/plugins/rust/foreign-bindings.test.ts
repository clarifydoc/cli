import { describe, it, expect } from "vitest";
import { rustForeignBindings } from "./foreign-bindings.js";

const reader = (files: Record<string, string>) => (path: string) => files[path];

describe("Rust generated bindings", () => {
  it("reads a flutter_rust_bridge configuration: its own api modules and another crate through the workspace", () => {
    const files = {
      "mobile/club/flutter_rust_bridge.yaml": "rust_input: crate::api, club-kit\nrust_root: ../../rust/bridge/\ndart_output: lib/src/rust\n",
      "mobile/club/pubspec.yaml": "name: club_app\n",
      "rust/bridge/Cargo.toml": '[package]\nname = "club-bridge"\n\n[dependencies]\nclub-kit = { workspace = true, features = ["contracts"] }\n',
      "rust/Cargo.toml": '[workspace]\nmembers = ["kit", "bridge"]\n\n[workspace.dependencies]\nclub-kit = { path = "kit" }\n',
    };
    const rules = rustForeignBindings("mobile/club", reader(files), new Set(["rust/kit/src/lib.rs", "rust/bridge/src/lib.rs"]));
    expect(rules.map((r) => [r.source, r.output, r.importPrefix, r.rename])).toEqual([
      ["rust/bridge/src/api", "mobile/club/lib/src/rust/api", "package:club_app/src/rust/api", "camel"],
      ["rust/kit/src", "mobile/club/lib/src/rust/third_party/club_kit", "package:club_app/src/rust/third_party/club_kit", "camel"],
    ]);
  });

  it("reads a wasm-pack build script: the crate's one module under its out-dir", () => {
    const files = {
      "web/wasm/package.json": JSON.stringify({ scripts: { build: "wasm-pack build ../../rust/club-wasm --target web --out-dir ../../web/wasm/pkg" } }),
      "rust/club-wasm/Cargo.toml": '[package]\nname = "club-wasm"\n',
    };
    const rules = rustForeignBindings("web/wasm", reader(files), new Set(["rust/club-wasm/src/lib.rs"]));
    expect(rules.map((r) => [r.source, r.output, r.single, r.rename, r.decorator?.renameArgument])).toEqual([
      ["rust/club-wasm/src", "web/wasm/pkg/club_wasm", true, "same", "js_name"],
    ]);
  });

  it("reads a wasm-pack script that moves into the crate, and the project crates the wasm crate links", () => {
    const files = {
      "web/wasm/cup/package.json": JSON.stringify({ scripts: { build: "cd ../../../rust/wasm/cup && wasm-pack build . --target bundler --out-dir ../../../web/wasm/cup/pkg" } }),
      "rust/wasm/cup/Cargo.toml": '[package]\nname = "cup-wasm"\n\n[dependencies]\nleague-kit = { workspace = true, features = ["fixtures"] }\nclub-kit = { path = "../../club" }\nserde = "1"\n',
      "rust/wasm/cup/src/lib.rs": "use league_kit as _;\n",
      "rust/Cargo.toml": '[workspace]\nmembers = ["league", "club", "wasm/cup", "scout"]\n\n[workspace.dependencies]\nleague-kit = { path = "league" }\nscout-kit = { path = "scout" }\n',
      "rust/league/Cargo.toml": '[package]\nname = "league-kit"\n\n[dependencies]\nscout-kit.workspace = true\n',
      "rust/league/src/lib.rs": "pub mod fixtures;\npub fn table() { scout_kit::report(); }\n",
      "rust/scout/Cargo.toml": '[package]\nname = "scout-kit"\n',
    };
    const rules = rustForeignBindings("web/wasm/cup", reader(files), new Set(["rust/wasm/cup/src/lib.rs", "rust/league/src/lib.rs", "rust/club/src/lib.rs", "rust/scout/src/lib.rs"]));
    // `club-kit` is a dependency the crate never names, so it is not linked in.
    expect(rules.map((r) => [r.source, r.output])).toEqual([
      ["rust/wasm/cup/src", "web/wasm/cup/pkg/cup_wasm"],
      ["rust/league/src", "web/wasm/cup/pkg/cup_wasm"],
      ["rust/scout/src", "web/wasm/cup/pkg/cup_wasm"],
    ]);
  });

  it("reads nothing where no generator is configured", () => {
    expect(rustForeignBindings("web/app", reader({ "web/app/package.json": '{"scripts":{"build":"vite build"}}' }), new Set())).toEqual([]);
  });
});
