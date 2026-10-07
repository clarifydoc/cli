import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * F# dead-code model. A project compiles exactly the files its `.fsproj`
 * lists (`<Compile Include="Domain.fs" />`), so the project file's mentions
 * keep them alive; types and functions are reached by name across the
 * assembly; the program starts at `[<EntryPoint>]` / `Program.fs`. A script
 * (`.fsx`) is run by `dotnet fsi` — kept alive, anchoring nothing.
 */
export const fsharpReachability = conventionReachability({
  extensions: [".fs", ".fsi", ".fsx"],
  importPath: (source) => (/^\.{1,2}\//.test(source) ? source : null),
  names: { types: true, functions: true, stem: true },
  mainFunctions: /^main$/,
  routesAreEntries: true,
  entryFiles: [[/(?:^|\/)Program\.fs$/i, "program entry"]],
  passiveFiles: [[/\.fsx$/i, "F# script"]],
  entryDecorators: /^(?:EntryPoint|ApiController|Route|Http(?:Get|Post|Put|Delete|Patch)|Fact|Theory|Test|TestCase|Property|Tests)\b/,
  configFiles: /\.fsproj$/i,
});
