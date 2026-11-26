# Raku plugin

Reads `.raku`, `.rakumod`, `.rakutest`, `.p6`, `.pm6`, `.pl6`, `.t6` with a regex front end (`RegexLangSpec`, `family: raku`).

## Ownership

- A `.pl` file with `use v6` stays Perl's.

## Routes and data

- Cro and Humming-Bird routes.
- DBIish SQL in strings and heredocs.
- Names are kebab-case.

## Packages and discovery

- `META6.json` is the package manifest, and `bin/` beside it is source (the manifest's `sourceDirs` re-admits a `bin/` that discovery would otherwise skip as .NET build output).
