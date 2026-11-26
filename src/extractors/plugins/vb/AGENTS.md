# VB plugin

Reads Visual Basic — VB.NET (`.vb`), VB6 (`.bas`, `.cls`, `.frm`) and VBScript (`.vbs`) — through the regex path (`RegexLangSpec` in [index.ts](index.ts); no grammar). Family `dotnet`, so bare-name import resolution trusts C# candidates and the other way round. The .NET-wide pieces (UI bridge, NuGet, service config) live in [../csharp/AGENTS.md](../csharp/AGENTS.md); cross-language mechanisms in [../AGENTS.md](../AGENTS.md).

## File map

- [manifest.ts](manifest.ts) — static tier (extensions, `caseInsensitiveNames`, `typesSpanFiles`, markers, `.cls` adoption by Apex).
- [index.ts](index.ts) — the `RegexLangSpec`: `.vbs` `topLevelCalls`, `notAfter` call patterns, attribute reading, logical statements.
- [control-flow.ts](control-flow.ts) — `blockDelta`/`blockClose`/`inlineGuard` for the shared regex CFG scanner.
- [routes.ts](routes.ts) — ASP.NET attribute routing in VB. [request-schema.ts](request-schema.ts) — wire shapes. [winforms-screens.ts](winforms-screens.ts) — designer-code screens. [data-sources.ts](data-sources.ts) — API call sites. [di.ts](di.ts) — container registrations and typed locals. [reachability.ts](reachability.ts) — C#-shaped model.
- [meta.ts](meta.ts) — runtime tier.

Each file's header comment holds its rules.

## Rules

- A VB project loads the C# plugin (its `dispatchLanguages`) so the UI-bridge resolver runs.
- A `CallPattern` anchored at a statement start sets `notAfter` so continuation lines are not calls; keywords are case-insensitive everywhere.

## Language server

The Docker LSP image is the .NET one: Roslyn `Microsoft.CodeAnalysis.LanguageServer` via the `misterkiem/roslyn-plusvb` fork that patches VB libraries into the upstream server; one container serves both `.cs` and `.vb`, and (like jdtls) its network is `"bridge"` because it restores packages to type-check (offline it loses most reference answers). Details in [../../../lsp/AGENTS.md](../../../lsp/AGENTS.md).
