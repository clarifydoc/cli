# Crystal plugin

Reads `.cr` source with a regex front end (`RegexLangSpec`, `family: crystal`); entities come from an `EntityExtractor` (`entities.ts`).

## Routes

- Kemal, Amber, Lucky, Athena, Marten and Spider-Gazelle routes are read.
- A top-level route block that runs later (`get "/x" do … end`) is listed in the spec's `deferredBlocks`: `<setup>` skips its body and the route carries the body's calls itself; `callSourceLines` blanks those bodies so a named function that registers the route does not count them again.

## Models and data

- Granite, Avram, Jennifer and Clear models are entities.
- A call such as `Post.find` is a query only when the project DECLARES `Post` a model; the join happens in the entity extractor's `reconcileProject`, so a namesake class never makes a table access.
- ORM naming uses the loose English inflection shared with Dart (`singularize`/`pluralize` in [../shared/inflection.ts](../shared/inflection.ts)).

## Packages

- `shard.yml` is the package manifest.
