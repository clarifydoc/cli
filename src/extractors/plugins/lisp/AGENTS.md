# Lisp family plugin (Racket, Scheme, Common Lisp)

Reads `.rkt` (Racket), `.scm`/`.ss`/`.sld`/`.sls` (Scheme) and `.lisp`/`.lsp`/`.asd` (Common Lisp) with a regex front end of the `lisp` family. Clojure (`.clj`/`.cljs`/`.cljc`, `clojure/`) is its own plugin that uses the same reader in its `lisp` dialect.

## Reader

- The plugin's specs are EMPTY: `postExtract` reads the whole file with the shared s-expression reader ([../shared/sexpr.ts](../shared/sexpr.ts)).
- Rows carry the open-paren offset the reader keeps on a `(` / `[` / `{` as `Form.column`, relative to the text read (a body slice's is its own).

## Definitions

- `define`, `defun` and `defmethod` (with specializers) are functions.
- `struct`, `defclass` and `define-record-type` are classes.

## Routes

- Racket `dispatch-rules`.
- Caveman and easy-routes `defroute`.
- Hunchentoot and Artanis.

## Packages

- `info.rkt` and the ASDF `.asd` file.
