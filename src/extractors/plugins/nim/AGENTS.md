# Nim plugin

Reads `.nim` / `.nims` source with a regex front end (`RegexLangSpec`, `source.ts`, `family: nim`).

## Routes and clients

- Jester `routes:` blocks and Prologue routes.
- Karax `ajaxGet` / `ajaxPost` calls are api-calls.
- SQL is read in strings.

## Blanking

- Command-call syntax is read; block comments and `"""` strings are blanked.

## Packages and dead code

- nimble `requires` lines name the packages.
- Dead code is judged by the declarative reachability spec built by [../shared/reachability-kit.ts](../shared/reachability-kit.ts).
