# Stylesheet plugin (SCSS, Sass, Less)

Reads `.scss`, `.sass` and `.less` with a regex front end of the `stylesheet` family. Structure only; plain `.css` is not analyzed.

## Functions and calls

- `@mixin`, `@function` and Less parameter mixins are functions.
- `@include`, `+mixin`, Less mixin statements and project function calls are calls. CSS and `sass:` built-ins never are.

## Imports

- `@use`, `@forward` and `@import` are imports.
- The manifest's `partialPrefix: "_"` makes `@use "buttons"` resolve to `_buttons.scss` in both resolvers.

## Setup

- A sheet's rules are its `<setup>`.
