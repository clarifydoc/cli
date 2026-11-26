# Perl plugin

Reads Perl (`.pl`, `.pm`, plus `.t`, `.psgi`, `.cgi`) with regex patterns; Perl states its own call forms. Shared regex mechanisms are in [../AGENTS.md](../AGENTS.md).

- [manifest.ts](manifest.ts) — which files are Perl (`.cgi` and shebang scripts are filtered in `preprocess` / `shebangInterpreter`); `docComments` uses `pod` for `=head`…`=cut`.
- [index.ts](index.ts) — the call patterns (`replacesBaseline`; `Pkg->m`, `Pkg::f(`, `$self->m(`, `use parent` / `use base` edges; builtins are no calls). Read the comment there before adding a form.
- [test-command.ts](test-command.ts), [project-commands.ts](project-commands.ts) — `testCommand` states `prove -l t/club.t`; a distribution gets `prove -lr t`.
- Control-flow graphs come from the regex scanner (`meta.regexControlFlow`), marked `approximate`. Reachability is a declarative spec of the shared kit; a CPAN library's modules are its API, never judged dead.
