# PropertyInfo — language × field coverage

Fields: **5 required** + 13 optional = 18. ✓=written, D=deliverable, N=not deliverable, ✗=required missing.

> **D** = not written, but the concept exists in that language and is extractable (a real gap). **N** = no such concept in that language/framework (a legitimate absence).

| language | name* | type* | visibility* | isStatic* | isReadonly* | decorators | isRequired | qualifier | readAccessor | commandHandler | accessor | from | constructedWith | assignedFrom | column | primaryKey | ref | boundFrom | cov |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bash `ts` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| csharp `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | ✓ | D | D | D | D | D | N | N | 10/18 |
| dfm `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | ✓ | N | N | N | N | N | N | N | N | N | 8/18 |
| fsharp `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | D | N | N | N | N | D | D | D | D | N | N | N | N | 5/18 |
| java `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | D | N | D | D | ✓ | ✓ | N | N | 10/18 |
| javascript `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | D | D | D | ✓ | N | N | N | 9/18 |
| julia `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | D | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| kotlin `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | D | D | D | D | ✓ | ✓ | N | N | 10/18 |
| ocaml `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | D | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| pascal `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | ✓ | N | N | N | N | N | N | N | N | N | 8/18 |
| php `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | D | D | D | D | D | D | N | N | 8/18 |
| python `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | D | ✓ | ✓ | ✓ | D | D | N | N | 11/18 |
| r `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | D | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| typescript `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | D | D | D | ✓ | N | N | N | 9/18 |
| zig `ts` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| applescript `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| autohotkey `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| autoit `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| batch `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| blazor `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| c `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| clojure `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | D | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| coffeescript `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| commonlisp `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| coredata `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| cpp `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| crystal `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| dart `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | ✓ | N | N | D | N | N | N | N | 9/18 |
| dlang `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| ejs `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| elixir `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| erb `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| erlang `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| fortran `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| freemarker `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| go `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | D | D | D | D | N | ✓ | 7/18 |
| gotemplate `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| graphql `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| groovy `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| handlebars `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| haskell `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| haxe `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| heex `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| html `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| jsight `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| jsp `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| less `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| liquid `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| lua `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| mojo `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| nim `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| objc `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| openapi `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | ✓ | N | 7/18 |
| perl `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| powershell `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| prisma `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | ✓ | N | N | N | 6/18 |
| protobuf `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| qml `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| qtui `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| racket `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| raku `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| razor `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| ruby `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | ✓ | N | N | D | D | D | D | D | N | N | N | 6/18 |
| rust `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | D | D | D | D | D | D | N | N | 6/18 |
| sass `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| scala `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | D | N | N | N | N | N | N | N | 8/18 |
| scheme `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| scss `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| serverless `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| springxml `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| sql `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | N | 5/18 |
| storyboard `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| swift `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | D | D | N | D | N | N | N | N | 8/18 |
| terraform `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| thrift `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| vb `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | 7/18 |
| velocity `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |
| vlang `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| wsdl `regex` | ✓ | ✓ | ✓ | ✓ | ✓ | N | ✓ | N | N | N | N | N | N | N | N | N | N | N | 6/18 |
| xaml `regex` | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | 0/18 |

\* = required field

## Gaps (fields not written by every producing language)

- `decorators`: missing in 27 → **D** fsharp, julia, ocaml, r, clojure; **N** zig, commonlisp, coredata, dlang, elixir, fortran, graphql, jsight, mojo, nim, objc, openapi, perl, prisma, protobuf, racket, ruby, scheme, springxml, sql, thrift, wsdl
- `isRequired`: missing in 33 → **N** dfm, fsharp, julia, ocaml, pascal, r, zig, applescript, autohotkey, c, commonlisp, coredata, cpp, crystal, dlang, fortran, go, groovy, haxe, mojo, nim, objc, powershell, prisma, racket, raku, ruby, rust, scheme, springxml, sql, vb, vlang
- `qualifier`: missing in 38 → **N** fsharp, julia, ocaml, r, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dlang, elixir, fortran, go, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, rust, scheme, springxml, sql, thrift, vlang, wsdl
- `readAccessor`: missing in 50 → **N** csharp, fsharp, java, javascript, julia, kotlin, ocaml, php, python, r, typescript, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, go, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, ruby, rust, scala, scheme, springxml, sql, swift, thrift, vb, vlang, wsdl
- `commandHandler`: missing in 51 → **N** dfm, fsharp, java, javascript, julia, kotlin, ocaml, pascal, php, python, r, typescript, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, go, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, ruby, rust, scala, scheme, springxml, sql, swift, thrift, vb, vlang, wsdl
- `accessor`: missing in 50 → **D** fsharp, java, kotlin, php, python, ruby, rust, scala, swift; **N** dfm, javascript, julia, ocaml, pascal, r, typescript, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dlang, elixir, fortran, go, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, scheme, springxml, sql, thrift, vb, vlang, wsdl
- `from`: missing in 51 → **D** csharp, fsharp, javascript, kotlin, php, typescript, ruby, rust, swift; **N** dfm, java, julia, ocaml, pascal, r, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, go, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, scala, scheme, springxml, sql, thrift, vb, vlang, wsdl
- `constructedWith`: missing in 51 → **D** csharp, fsharp, java, javascript, kotlin, php, typescript, go, ruby, rust; **N** dfm, julia, ocaml, pascal, r, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, scala, scheme, springxml, sql, swift, thrift, vb, vlang, wsdl
- `assignedFrom`: missing in 51 → **D** csharp, fsharp, java, javascript, kotlin, php, typescript, dart, go, ruby, rust, swift; **N** dfm, julia, ocaml, pascal, r, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dlang, elixir, fortran, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, scala, scheme, springxml, sql, thrift, vb, vlang, wsdl
- `column`: missing in 47 → **D** csharp, php, python, go, ruby, rust; **N** dfm, fsharp, julia, ocaml, pascal, r, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, protobuf, racket, raku, scala, scheme, springxml, sql, swift, thrift, vb, vlang, wsdl
- `primaryKey`: missing in 50 → **D** csharp, php, python, go, rust; **N** dfm, fsharp, javascript, julia, ocaml, pascal, r, typescript, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, ruby, scala, scheme, springxml, sql, swift, thrift, vb, vlang, wsdl
- `ref`: missing in 51 → **N** csharp, dfm, fsharp, java, javascript, julia, kotlin, ocaml, pascal, php, python, r, typescript, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, go, graphql, groovy, haxe, jsight, mojo, nim, objc, perl, powershell, prisma, protobuf, racket, raku, ruby, rust, scala, scheme, springxml, sql, swift, thrift, vb, vlang, wsdl
- `boundFrom`: missing in 51 → **N** csharp, dfm, fsharp, java, javascript, julia, kotlin, ocaml, pascal, php, python, r, typescript, zig, applescript, autohotkey, c, clojure, commonlisp, coredata, cpp, crystal, dart, dlang, elixir, fortran, graphql, groovy, haxe, jsight, mojo, nim, objc, openapi, perl, powershell, prisma, protobuf, racket, raku, ruby, rust, scala, scheme, springxml, sql, swift, thrift, vb, vlang, wsdl

_Never produces PropertyInfo:_ bash, autoit, batch, blazor, coffeescript, ejs, erb, erlang, freemarker, gotemplate, handlebars, haskell, heex, html, jsp, less, liquid, lua, qml, qtui, razor, sass, scss, serverless, storyboard, terraform, velocity, xaml
