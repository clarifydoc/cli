# HTML plugin

Reads vanilla `.html` / `.htm` with a regex front end (`RegexLangSpec`, [index.ts](index.ts)); [project-root-pages.ts](project-root-pages.ts) handles pages at the project root. Blade and CodeIgniter views also go through this reader.

- A POST form with no action posts to its own page (`InteractiveElementInfo.ownViewPost`); core's [own-view-posts.ts](../../../core/own-view-posts.ts) turns it into `POST <path>` when every route rendering the screen is at one path. A template served at two paths says nothing.
- Element-request rows (`shared/element-requests.ts`) take their column from the reader's `InteractiveElementInfo.column`.
