import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/**
 * Ruby dead-code model. `require`/`require_relative` name files; under Rails
 * (Zeitwerk) a constant is loaded the first time its NAME is used, so classes
 * and modules are reached by name. Rails routes controllers by convention
 * (`resources :users` → UsersController) and looks helpers, serializers,
 * policies, decorators and validators up from a model's name — those are
 * entries or never judged. `bin/*` scripts are read as `#!` scripts.
 */
export const rubyReachability = conventionReachability({
  extensions: [".rb", ".rake"],
  importPath: (source) => (/^[\w./-]+$/.test(source) ? source.replace(/\.rb$/, "") : null),
  names: { types: true, stem: true, declaration: /\b(?:class|module)\s+((?:[A-Z]\w*::)*[A-Z]\w*)/g },
  entryFiles: [
    [/^config\.ru$/, "Rack entry"],
    [/^(?:bin|exe)\//, "executable"],
    [/^config\//, "loaded at boot"],
  ],
  frameworkPassive: {
    rails: [
      [/^app\/(?:controllers|channels|admin)\//, "routed / discovered by Rails"],
      [/^app\/(?:helpers|serializers|policies|decorators|validators|inputs|presenters|views)\//, "looked up by naming convention"],
    ],
    hanami: [[/^(?:app|slices)\/[^/]+\/actions\//, "Hanami action"]],
  },
  passiveFiles: [
    [/^db\/(?:migrate\/|seeds)/, "database task"],
    [/^lib\/tasks\//, "Rake task"],
    [/\.rake$/, "Rake task"],
    [/(?:^|\/)(?:Rakefile|Gemfile|Guardfile|Capfile|Vagrantfile|Dangerfile|Fastfile|Podfile)$/, "tool file"],
  ],
  entrySource: [[/__FILE__\s*==\s*\$(?:0|PROGRAM_NAME)/, "script (`__FILE__ == $0`)"]],
  configFiles: /(?:^|\/)config\/[^/]+\.ya?ml$|\.gemspec$/,
  shebang: /\bruby\b/,
  // A gem (a root with a .gemspec) publishes lib/: its consumers live in
  // other repositories.
  async extend(_ctx, kit, base) {
    const gemRoots = new Set<string>();
    for (const rel of await kit.listFiles()) {
      if (rel.endsWith(".gemspec")) gemRoots.add(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
    }
    return withPassive(base, (analysis, relPath) =>
      gemRoots.has(kit.rootOf(analysis.filePath)) && relPath.startsWith("lib/") ? "published gem (library API)" : null,
    );
  },
});
