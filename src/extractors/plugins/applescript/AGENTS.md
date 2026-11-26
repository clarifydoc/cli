# AppleScript plugin

Reads `.applescript` source with a regex front end (`RegexLangSpec`, `family: applescript`).

## Functions and blanking

- `on x` … `end x` handlers and `script` objects are functions, both through one `keyword-end` rule.
- `(* *)` block comments are blanked.

## Calls and HTTP

- Element specifiers such as `paragraph (n)` are never calls.
- `curl` inside `do shell script` is an api-call; concatenated pieces of the command leave holes in the URL.
