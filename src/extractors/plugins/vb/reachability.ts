import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * VB.NET dead-code model — the C# model's shape: `Imports` names a
 * namespace, types are reached by name, a program starts at `Program`/`Main`
 * (`My Project`'s `Application.myapp` names the startup form), and what
 * WinForms, ASP.NET or a test runner discovers is kept alive.
 */
export const vbReachability = conventionReachability({
  extensions: [".vb"],
  names: {
    types: true,
    functions: true,
    stem: true,
    declaration: /\b(?:Class|Structure|Interface|Enum|Module)\s+([A-Za-z_]\w*)/gi,
    methodsOf: /(?:Extensions?|Ext)$/,
  },
  mainFunctions: /^Main$/i,
  routesAreEntries: true,
  entryFiles: [
    [/(?:^|\/)(?:Program|Startup|MauiProgram|Module1|ApplicationEvents|Global\.asax)\.vb$/i, "conventional .NET entry"],
    [/(?:^|\/)App\.xaml\.vb$/i, "application class"],
  ],
  passiveFiles: [
    [/(?:^|\/)Migrations\//, "EF migration"],
    [/(?:^|\/)My Project\//, "project metadata"],
  ],
  entryDecorators: /^(?:ApiController|Route|Http(?:Get|Post|Put|Delete|Patch)|TestClass|TestFixture|Fact|Theory|Test|TestMethod|WebService|ServiceContract|FunctionName)\b/i,
  entryBaseTypes:
    /^(?:ControllerBase|Controller|ApiController|Form|Window|Page|UserControl|Application|ServiceBase|Installer|BackgroundService|IHostedService|DbContext|Hub)$/i,
  configFiles: /(?:^|\/)(?:[^/]*\.config|Application\.myapp|appsettings[^/]*\.json|[^/]*\.aspx|[^/]*\.asmx)$/i,
});
