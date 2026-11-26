# Tcl plugin

Reads `.tcl` / `.tm` source with a regex front end (`RegexLangSpec`, `index.ts`, `family: tcl`).

## Structure

- `proc` and `method` are functions; `class`, `itcl::class`, `snit::type` and `oo::class create` are classes.
- Blocks end at the matching brace, counted over the whole file (`blockEnds`); only a backslash-escaped brace is skipped.

## Calls

- A call is a command word: first on a line, after `[`, after `;`. Core commands and Tk widget commands are not calls.
- A file's own statements run, so calls outside every proc are its `<setup>`.

## Imports

- `source file.tcl` names a file and shares the caller's scope. `package require` is no import: an installed package would resolve to a project file of the same stem.
