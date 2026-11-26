# Templates plugin

Reads server-side template files (Handlebars, Liquid, Velocity, Go templates, FreeMarker, EJS, Razor `.cshtml`) with a regex front end (`RegexLangSpec`).

## Screens

- A template made only of the partials it includes is a page; an include resolves by its path (`includedFile`).
- A component most pages of a sub-project include (`FRAME_PAGES` / `FRAME_SHARE`) is their frame, a `shell` node in the navigation map (core's screen pass).

## Razor tag helpers

- Tag helpers name their target, not a path (`RazorTargetResolver`, [razor-target-resolver.ts](razor-target-resolver.ts), `razor-target`): `asp-controller="Account" asp-action="Login"` is `AccountController.Login`, and `asp-page="/Account/Login" asp-page-handler="Delete"` is `OnPostDelete` (or `OnPostDeleteAsync`) of the page model in `Pages/Account/Login.cshtml.cs`. The verb picks the overload: a POST form reaches the action marked `[HttpPost]` when the controller has both.
