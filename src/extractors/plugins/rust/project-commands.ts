import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** Cargo builds and tests the package; `cargo run` when it has a binary. */
export function rustProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const cargo = root.read("Cargo.toml");
  if (cargo === undefined) return [];
  const out: ProjectCommand[] = [
    { kind: "build", command: "cargo build", source: "Cargo.toml" },
    { kind: "test", command: "cargo test", source: "Cargo.toml" },
  ];
  if (root.exists("src/main.rs") || /^\[\[bin\]\]/m.test(cargo)) out.push({ kind: "start", command: "cargo run", source: root.exists("src/main.rs") ? "src/main.rs" : "Cargo.toml [[bin]]" });
  return out;
}
