# V plugin

Reads `.v` / `.vsh` source with a regex front end (`RegexLangSpec`, `source.ts`, `family: vlang`).

## Routes and data

- veb / vweb attribute routes.
- ORM `sql db { … }` statements are data accesses.

## Structure

- Receiver methods are attached to their struct.

## Refusals

- Verilog and Coq `.v` files are refused.

## Packages and dead code

- `v.mod` is the package manifest.
- Dead code is judged by the declarative reachability spec built by [../shared/reachability-kit.ts](../shared/reachability-kit.ts).
