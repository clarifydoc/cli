# CoffeeScript plugin

Reads CoffeeScript with regex patterns ([index.ts](index.ts)), in the `script` family: Express routes and Backbone/jQuery API calls. Implicit calls are read and multi-line strings are blanked.

- `deferredBlocks` lists a top-level block that only registers code to run later, so `<setup>` skips its body and the route carries the body's calls itself (`app.get '/x', (req, res) ->`). Handler shapes read: a one-line body `-> res.send 'ok'`, a continuation-line handler (`app.get '/x',` then an indented `(req, res) ->`), and handlers inside a `module.exports = (app) ->` or a named registrar.
- A relative import written without an extension also tries every extension of the importer's family: `require './x'` → `x.coffee`. Dead code: a declarative reachability spec of the shared kit.
