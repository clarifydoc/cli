# Templates plugin

Reads server-side template files (Handlebars, Liquid, Velocity, Go templates, FreeMarker, EJS, Razor `.cshtml`) with a regex front end (`RegexLangSpec`, [index.ts](index.ts)).

- A template made only of the partials it includes is a page; an include resolves by its path (`includedFile`). A component most pages of a sub-project include (`FRAME_PAGES` / `FRAME_SHARE`) is their frame, a `shell` node in the navigation map (core's screen pass).
- [razor-target-resolver.ts](razor-target-resolver.ts) — `RazorTargetResolver` (`razor-target`): Razor tag helpers name a controller action or page handler, not a path.
