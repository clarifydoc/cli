import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * C# dead-code model. A `using` names a namespace, never a file: types are
 * found by NAME across the assembly, so a file is reached when reachable code
 * mentions a type it declares. A program starts at `Program.cs`/`Main`;
 * what ASP.NET, the generic host, MediatR, EF, FluentValidation, AutoMapper,
 * SignalR, WinForms/WPF/MAUI and test runners discover by attribute or base
 * type (usually through assembly scanning) is kept alive and never reported,
 * but anchors nothing — a class library full of controllers is still a
 * library.
 */
export const csharpReachability = conventionReachability({
  extensions: [".cs", ".csx"],
  names: {
    types: true,
    functions: true,
    stem: true,
    declaration: /\b(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/g,
    // Extension methods are called on the extended value (`x.Slugify()`),
    // never through their class.
    methodsOf: /(?:Extensions?|Ext)$/,
    // C# 14 extension blocks (the grammar reads `extension(…) { … }` as one method named `extension`).
    sourceMembers: {
      when: /^\s*extension\s*(?:<[^>]*>)?\s*\(/m,
      member: /^\s*public\s+(?:static\s+|async\s+|override\s+|virtual\s+)*(?:[\w<>[\],.?]+\s+)+?([A-Z]\w*)\s*(?:<[^>]*>)?\s*[({]/gm,
    },
  },
  mainFunctions: /^Main$/,
  routesAreEntries: true,
  entryFiles: [
    [/(?:^|\/)(?:Program|Startup|MauiProgram|GlobalUsings)\.cs$/i, "conventional .NET entry"],
    [/(?:^|\/)(?:App|Global)\.(?:xaml|asax)\.cs$/i, "application class"],
  ],
  // BenchmarkDotNet discovers `[Benchmark]` methods by reflection: run by the tool, never imported.
  passiveSource: [[/\[\s*Benchmark\b/, "BenchmarkDotNet benchmark"]],
  passiveFiles: [
    // Run by dotnet-script, never compiled into the assembly: a script keeps
    // what it mentions alive, but a repo of tooling scripts is not a program.
    [/\.csx$/i, "C# script"],
    [/(?:^|\/)Migrations?\//, "migration (EF Core, FluentMigrator)"],
    [/(?:^|\/)Properties\/AssemblyInfo\.cs$/, "assembly metadata"],
  ],
  entryDecorators:
    /^(?:ApiController|Route|Http(?:Get|Post|Put|Delete|Patch|Head|Options)|Function|FunctionName|ServiceContract|WebService|TestClass|TestFixture|Fact|Theory|Test|TestMethod|Export|Command|Verb|Hub|QueueTrigger|TimerTrigger|HttpTrigger|ServiceBusTrigger|EventHubTrigger|BlobTrigger)\b/,
  entryBaseTypes:
    /^(?:ControllerBase|Controller|ApiController|ODataController|Hub|BackgroundService|IHostedService|IStartupFilter|PageModel|ComponentBase|LayoutComponentBase|OwningComponentBase|Profile|AbstractValidator|DbContext|IdentityDbContext|IEntityTypeConfiguration|IRequestHandler|INotificationHandler|IPipelineBehavior|IStreamRequestHandler|IRequestPreProcessor|IRequestPostProcessor|IConsumer|IHandleMessages|IJob|IHealthCheck|IMiddleware|IAuthorizationHandler|AuthorizationHandler|ActionFilterAttribute|ExceptionFilterAttribute|ResultFilterAttribute|IActionFilter|IAsyncActionFilter|IExceptionFilter|IAsyncExceptionFilter|IResultFilter|IAuthorizationFilter|IAsyncAuthorizationFilter|IModelBinder|IModelBinderProvider|IOperationFilter|ISchemaFilter|IDocumentFilter|TagHelper|ViewComponent|Form|Window|Page|UserControl|Application|ContentPage|ContentView|Shell|ServiceBase|Installer|Grain|ICommandHandler|IQueryHandler|IEventHandler|IIntegrationEventHandler|IDomainEventHandler|ITypeConverter|IValueResolver|IMemberValueResolver|Migration|\w+ServiceBase)$/,
  // Not *.csproj: an old-style project lists every compiled file, which would
  // make every file "named in configuration".
  configFiles: /(?:^|\/)(?:appsettings[^/]*\.json|[^/]*\.config|[^/]*\.cshtml|launchSettings\.json)$/i,
});
