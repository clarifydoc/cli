# HTML plugin

Reads vanilla `.html` / `.htm` with a regex front end (`RegexLangSpec`); `project-root-pages.ts` handles pages at the project root. Blade and CodeIgniter views also go through this reader.

## A POST form with no action posts to its own page

- The reader marks a `<form>` (and its submit controls) `InteractiveElementInfo.ownViewPost` when it has no `action` or `action=""`. A template expression in the attribute is a URL and never marks it; GET never marks it.
- Core's [own-view-posts.ts](../../../core/own-view-posts.ts) gives the form `POST <path>` when every route rendering the screen (`ScreenInfo.renderedBy`) is at one path; the api-call then joins the route linker like a written-out action. A template served at two paths says nothing.

## Columns

- The reader states `InteractiveElementInfo.column` (the tag's offset) only on an element carrying a `request` or `ownViewPost`, and only while the masked line still starts with the given one (a removed comment shifts it). Element-request rows (`shared/element-requests.ts`) take their column from it.

## Screens

- A file routing itself (an HTML page) that a route table also routes is one screen.
