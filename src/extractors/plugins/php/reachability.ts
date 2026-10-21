import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/**
 * PHP dead-code model. Composer autoloads a class the first time its NAME is
 * used, so classes are reached by name; `use App\Http\Foo` also names the
 * file under PSR-4 (matched case-insensitively: `App\` lives in `app/`), and
 * `require`/`include` name files outright. Entries: front controllers, route
 * and config files, what Laravel, Symfony and CodeIgniter discover by
 * convention, attribute or base type; `artisan`/`bin/console` are read as
 * `#!` scripts.
 */
export const phpReachability = conventionReachability({
  extensions: [".php"],
  caseInsensitive: true,
  importPath: (source) => {
    if (/\.php$/i.test(source)) return source;
    return /^\\?[A-Za-z_][\w\\]*$/.test(source) ? source.replace(/^\\/, "").replace(/\\/g, "/") : null;
  },
  names: { types: true, functions: true, stem: true, declaration: /\b(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gi },
  routesAreEntries: true,
  entryFiles: [
    [/(?:^|\/)(?:index|artisan|server|router|wp-config|functions|cli|console)\.php$/i, "conventional PHP entry"],
    [/^(?:public|web|htdocs|www|public_html)\/[^/]+\.php$/, "web root script"],
    [/^routes\/[^/]+\.php$/, "route file"],
    [/^config\/[^/]+\.php$/, "configuration"],
    [/^bootstrap\/[^/]+\.php$/, "bootstrap"],
    [/^src\/Kernel\.php$/, "Symfony kernel"],
  ],
  passiveFiles: [
    [/^database\//, "migrations, seeders, factories"],
    [/(?:^|\/)migrations?\//, "migration"],
    [/\.blade\.php$/, "Blade view"],
    [/^(?:resources\/views|templates?|views?)\//, "view template"],
    [/^app\/(?:Console\/Commands|Policies|Listeners|Observers|View\/Components|Livewire|Providers)\//, "discovered by the framework"],
    [/^application\/(?:controllers|config|hooks|views|language)\//, "routed / loaded by CodeIgniter"],
    // `subclass_prefix` (`MY_` by default): `MY_Form_validation` replaces the
    // framework's class wherever `form_validation` is loaded — no file names it.
    [/^application\/(?:core|libraries)\/[A-Z][A-Z0-9]*_[A-Z]\w*\.php$/, "CodeIgniter subclass-prefix extension"],
  ],
  entryDecorators:
    /^(?:Route|AsCommand|AsController|AsEventListener|AsMessageHandler|AsTwigComponent|AsLiveComponent|AsCronTask|AsPeriodicTask|ApiResource|Autoconfigure|AsDecorator|AsTaggedItem)\b/,
  entryBaseTypes:
    /^(?:ServiceProvider|CI_Controller|EventSubscriberInterface|AbstractExtension|Bundle|AbstractBundle|Seeder|Command|TestCase|WebTestCase|KernelTestCase)$/,
  configFiles: /(?:^|\/)(?:composer\.json|config\/[^/]+\.(?:ya?ml|xml)|services\.(?:ya?ml|xml)|[^/]*\.neon|phpunit\.xml(?:\.dist)?)$/,
  shebang: /\bphp\b/,
  // A Composer package that is not a project and has no front controller is
  // a library: its classes are for its consumers.
  async extend(_ctx, kit, base) {
    const libraryRoots = new Set<string>();
    for (const root of kit.roots) {
      const composer = await kit.readText(root ? `${root}/composer.json` : "composer.json");
      if (!composer || /"type"\s*:\s*"project"/.test(composer)) continue;
      const front = kit.files.some((f) => {
        const rel = root && f.startsWith(root + "/") ? f.slice(root.length + 1) : f;
        return /^(?:(?:public|web|htdocs|www)\/)?index\.php$/.test(rel);
      });
      if (!front) libraryRoots.add(root);
    }
    return withPassive(base, (analysis) =>
      libraryRoots.has(kit.rootOf(analysis.filePath)) ? "Composer library (public API)" : null,
    );
  },
});
