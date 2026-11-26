# Fortran plugin

Reads fixed-form and free-form Fortran (`.f`, `.for`, `.f77`, `.f90`, `.f95`, `.f03`, `.f08`, `.fpp`) with a regex front end (`RegexLangSpec`, `source.ts`, `family: fortran`).

## Normalization

- Fixed and free form are normalized to one statement per line before patterns run.

## Calls

- Calls are `call` statements plus the function references the file can prove.
- The generic `name(` matcher is off: `a(i)` is usually an array element.

## Dead code

- Dead code is judged by the declarative reachability spec built by [../shared/reachability-kit.ts](../shared/reachability-kit.ts).
