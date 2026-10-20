import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** Bundler with RSpec or Rake's test task; Rails' server. */
export function rubyProjectCommands(root: ProjectRootView): ProjectCommand[] {
  if (!root.entries.includes("Gemfile")) return [];
  const gemfile = root.read("Gemfile") ?? "";
  const out: ProjectCommand[] = [];
  if (root.entries.includes("spec") || /\brspec\b/.test(gemfile)) out.push({ kind: "test", command: "bundle exec rspec", source: "Gemfile + spec/" });
  else if (root.entries.includes("Rakefile")) out.push({ kind: "test", command: "bundle exec rake test", source: "Rakefile" });
  if (root.exists("bin/rails")) out.push({ kind: "start", command: "bin/rails server", source: "bin/rails" });
  return out;
}
