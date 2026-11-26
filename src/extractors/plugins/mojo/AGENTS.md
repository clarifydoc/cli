# Mojo plugin

Reads `.mojo` / `.🔥` source with a regex front end (`RegexLangSpec`, `family: mojo`).

## Structure

- Indentation blocks are read as Python's.
- `fn` and `def` are functions; `struct`s are classes with their traits and fields; argument conventions are read.

## Routes and calls

- lightbug_http `HTTPService` path branches are routes.
- Python-interop `requests` calls are api-calls.

## Packages

- `mojoproject.toml` and `pixi.toml` list conda packages.
