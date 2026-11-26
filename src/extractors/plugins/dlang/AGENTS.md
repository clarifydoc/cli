# D plugin

Reads `.d` and `.di` source with a regex front end (`RegexLangSpec`, `family: dlang`).

## Routes

- vibe.d `URLRouter` routes are read.
- REST and web interfaces are routed by vibe's own naming rules.

## Data

- SQL is read in every D string form.
- MongoDB collections are data sources.

## Refusals

- Make dependency `.d` files are refused by `preprocess`.

## Packages and dead code

- `dub.json` / `dub.sdl` are the package manifests.
- Dead code is judged by the declarative reachability spec built by [../shared/reachability-kit.ts](../shared/reachability-kit.ts).
