# AutoIt plugin

Reads `.au3` source with a regex front end (`RegexLangSpec`, `family: autoit`).

## Functions and blanking

- `Func` … `EndFunc` delimit a function through the `keyword-end` rule.
- `#cs` / `#ce` comment blocks are blanked.
- Names are case-insensitive.

## Data and HTTP

- `_SQLite_*` calls carry SQL.
- `InetGet` and WinHttp calls are api-calls.
