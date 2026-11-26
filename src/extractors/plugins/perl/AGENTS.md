# Perl plugin

Reads Perl (`.pl`, `.pm`, plus `.t`, `.psgi`, `.cgi`) with regex patterns; Perl states its own call forms. Shared regex mechanisms are in [../AGENTS.md](../AGENTS.md).

## Files

- `.cgi` is shared with any language: the plugin refuses foreign files from `preprocess` with `{ skip }`. A `.pl` with `use v6` stays Perl's (the Raku plugin does not claim it).
- Extension-less scripts whose `#!` line names a Perl interpreter (`shebangInterpreter`) are Perl files.
- Doc comments: the manifest's `docComments` uses `pod` for `=head`…`=cut`.

## Calls (`replacesBaseline`)

- `Pkg->m` and `Pkg::f(` are calls on the package, spelled `Pkg.m` with `receiverType`; `nestedTypePaths` keeps `League::Club` apart from `Garage::Club`.
- `my $x = Pkg->new` types the local (not a chained `Pkg->new->build`); `$x->m(` needs its parentheses and links the package's sub.
- `$self->m(` / `__PACKAGE__->m` resolve on the enclosing package and its `use parent` / `use base` parents (`-norequire`, lists, `qw`); the first parent is `extends`, the rest `implements`.
- Builtins are no calls.
- A package-less script's statements are its `<setup>`.

## Control flow, tests, dead code

- Control-flow graphs come from the regex scanner (`meta.regexControlFlow`), marked `approximate`.
- `testCommand` states `prove -l t/club.t`; a distribution gets `prove -lr t`.
- Reachability is a declarative spec of the shared kit; a CPAN library's modules are its API, never judged dead.
