# CoffeeScript plugin

Reads CoffeeScript with regex patterns, in the `script` family: Express routes and Backbone/jQuery API calls. Implicit calls are read and multi-line strings are blanked.

## Routes

- A top-level block that only registers code to run later is listed by `deferredBlocks`, so `<setup>` skips its body and the route carries the body's calls itself (`app.get '/x', (req, res) ->`).
- Handler shapes read: a one-line body `-> res.send 'ok'`, a continuation-line handler (`app.get '/x',` then an indented `(req, res) ->`), and handlers inside a `module.exports = (app) ->` or a named registrar.

## Imports

- A relative import written without an extension also tries every extension of the importer's family: `require './x'` → `x.coffee`.
- Dead code: a declarative reachability spec of the shared kit.
