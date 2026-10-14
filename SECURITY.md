# Security

## Reporting a vulnerability

Please report security issues privately — through GitHub's
[private vulnerability reporting](https://github.com/clarifydoc/cli/security/advisories/new) for this
repository, or by email to [support@clarifydoc.com](mailto:support@clarifydoc.com) with "security" in the
subject. Do not open a public issue for a vulnerability.

Include what you ran, what happened, and — if you can — a repository or file that reproduces it. You will
get an acknowledgement, and a fix or an explanation; please give us a reasonable time to ship a fix before
you disclose.

## What is in scope

ClarifyDoc reads source code it did not write, so the analyzer itself is attack surface. Of particular
interest:

- anything in an analyzed repository that makes `clarifydoc analyze` read or write outside that repository
  (symlinks, path traversal in config files, archive or include directives);
- anything in an analyzed repository that makes it execute code — the analyzer parses, it never runs
  the project;
- content that escapes the generated `report.html` (it embeds names, paths and snippets from the analyzed
  code) or the MCP server's output;
- a crash or hang on hostile input that a malicious repository could use to stop an automated analysis.

## What leaves your machine

Your source code is never sent anywhere. The analyzer works on the files on disk and writes its results
next to them. Network access happens only in these cases:

| When | What is contacted | What is sent |
|---|---|---|
| Docker is available and LSP enhancement is on (the default; `--no-lsp` turns it off) | Docker registries and the language servers' package registries, the first time each language-server image is built | Nothing from your code — only the image build's own downloads. The language servers then run locally, in containers, on your files |
| `--osv` | `api.osv.dev` | The names and versions of the packages your manifests declare |

There is no telemetry. `report.html` is a single self-contained file that makes no network requests.
