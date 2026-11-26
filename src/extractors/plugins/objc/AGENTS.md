# Objective-C plugin

Reads Objective-C and Objective-C++ (`.m`, `.mm`) through regex patterns with a tree-sitter front end for functions and calls (`meta.treeSitter`, `tree-sitter.ts`, grammar `tree-sitter-objc` registered as variant `objc`; `parsing` stays `"regex"`; on by default, no ANTLR reader). It is a `cfam` plugin: the facts it shares with C and C++ (includes, headers, macros and their links, reachability, control flow, test commands) are in [../cpp/AGENTS.md](../cpp/AGENTS.md). Parser internals: [../../../parsers/AGENTS.md](../../../parsers/AGENTS.md).

## Files

- [tree-sitter.ts](tree-sitter.ts) — message sends, constructions, chains; [receivers.ts](receivers.ts) — receiver types from parameters, locals, `@property`; [member-effects.ts](member-effects.ts) — field writes and throws.
- [manifest.ts](manifest.ts) — external SDK prefixes, cross-file type spans, `#import` scope, test-file patterns; [packages.ts](packages.ts) — SwiftPM/CocoaPods.

Reachability is the C-family instance shared with C and C++; control flow goes through `meta.regexControlFlow` (approximate).
