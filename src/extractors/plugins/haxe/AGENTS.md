# Haxe plugin

Reads `.hx` source with a regex front end (`RegexLangSpec`, `family: haxe`); `data-sources.ts` and `entities.ts` hold the data readers.

## Routes and clients

- tink_web metadata routes, on the line above or on the declaration itself.
- Express on hxnodejs.
- `haxe.Http` calls are api-calls.

## Models

- record-macros models are entities.

## Typing

- A capitalized receiver is a class, so `Orders.close()` states its type.

## Packages

- `haxelib.json` and `.hxml` `-lib` lines name the packages.
