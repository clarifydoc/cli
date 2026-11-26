# Objective-C plugin

Reads Objective-C and Objective-C++ (`.m`, `.mm`) through regex patterns with a tree-sitter front end for functions and calls (`meta.treeSitter`, `tree-sitter.ts`, grammar `tree-sitter-objc` registered as variant `objc`; `parsing` stays `"regex"`). It is a `cfam` plugin: the facts it shares with C and C++ (includes, headers, macros, reachability, control flow, test commands) are in [../cpp/AGENTS.md](../cpp/AGENTS.md). Parser internals: [../../../parsers/AGENTS.md](../../../parsers/AGENTS.md).

## Front end

- The tree-sitter reader is on by default; `no-tree-sitter:objc` (feature `tree-sitter`) switches it off, and a file it parses with syntax errors keeps the regex reading (`FileAnalysis.frontEnd`). A language with both front ends uses ANTLR's; Objective-C has none.
- It reads message sends on property paths, constructions and other sends; a method is named by its selector's first piece, as the patterns name it. A chain is named up to eight calls deep (`CHAIN_DEPTH`) and the linker types each step through declared return types. `[[Club alloc] init…]` and `[Club new]` are constructions (`CONSTRUCTING`: `alloc`, `new`); with `constructorCalls: ["init", "new"]` the link goes to the class when it declares no `init` of its own, as a Java `new Club()` without a declared constructor does.
- Objective-C `.m`/`.mm` read their own function-like `#define`s as C does (`extractMacros` on the spec; macro-body links are in the C++ file).
- `externalModulePrefixes` (`Foundation`, `UIKit`, …) and `externalNamespaceRoots` (`NS`, `UI`, `CG`, `CA`, `CF`) keep SDK names off project classes (an external import never binds a project file); package ecosystems are `swiftpm` and `cocoapods`.

## Types and scope

- `receivers.ts` states what the source says about a receiver's type, facts only: method parameters (`(Club *)visitor`) and return type, a typed local (`Club *c = …`), a class's `@property Club *home` with the `_home` instance variable it synthesizes (or one declared in the braces after `@interface`); `objcType` reduces `Club *`, `__kindof Club *_Nullable`, `id<Scoring>` and `NSArray<Club *> *` to a class, and `id`, `void`, `instancetype`, a block or a function pointer to none. The linker types the message send `[self.home retire]`, named `home.retire`, from the property.
- One type spans files (`typesSpanFiles: true`): categories and the `@implementation` file add to a class declared elsewhere.
- `#import "Club.h"` puts the C functions `Club.h` declares in scope (`importsShareScope`, `declarationExtensions: [".h"]`); `Club.m` holds their bodies.

## Effects, reachability and flow

- `fieldWrites` (and thrown types) are stated for Objective-C (`member-effects.ts`: `self.x =`, `self.a.b =`, `obj.x =`, bare ivars, compound operators, `count++` as a statement of its own).
- Reachability is the C-family instance shared with C and C++; control flow goes through `meta.regexControlFlow` (approximate).
- Test files are `*Test.m`, `*Tests.m` and the `.mm` forms (`testFilePatterns`).
