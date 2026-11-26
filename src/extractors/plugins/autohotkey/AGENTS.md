# AutoHotkey plugin

Reads AutoHotkey v1 and v2 (`.ahk`, `.ah2`) with a regex front end (`RegexLangSpec`, `family: autohotkey`).

## Functions

- A candidate `Name(…)` is a function only when `{` or `=>` follows it; a call looks the same.
- Hotkeys (`^j::`) and v1 labels are entry functions.

## HTTP

- WinHttp COM calls are api-calls.
