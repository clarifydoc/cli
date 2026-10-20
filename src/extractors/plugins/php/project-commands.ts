import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** composer.json scripts, else PHPUnit's runner; Laravel's artisan serve. */
export function phpProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const text = root.read("composer.json");
  if (!text) return [];
  let composer: { scripts?: Record<string, unknown> };
  try {
    composer = JSON.parse(text);
  } catch {
    return [];
  }
  const out: ProjectCommand[] = [];
  if (composer.scripts?.test) out.push({ kind: "test", command: "composer test", source: "composer.json scripts.test" });
  else if (root.entries.includes("phpunit.xml") || root.entries.includes("phpunit.xml.dist")) out.push({ kind: "test", command: "vendor/bin/phpunit", source: root.entries.includes("phpunit.xml") ? "phpunit.xml" : "phpunit.xml.dist" });
  if (root.entries.includes("artisan")) out.push({ kind: "start", command: "php artisan serve", source: "artisan" });
  return out;
}
