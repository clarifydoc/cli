import type { FrameworkRule } from "../../../types/language-plugin.js";
import {
  hasCsprojFrameworkRef,
  hasCsprojPackage,
  hasCsprojProp,
  hasCsprojSdk,
} from "../shared/project-info-queries.js";

/** .NET framework rules — web, desktop UI stacks, and ORMs, all via .csproj scanning. */
export const csharpFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "aspnet",
    name: "ASP.NET",
    // A `.csproj` alone means "some .NET project" — NOT ASP.NET (it's just as
    // likely a desktop/Blazor/console/library project). Require a real server-web
    // signal: the Web SDK, the AspNetCore shared framework, or an MVC package.
    // (Blazor's `Microsoft.AspNetCore.Components.*` is deliberately NOT counted —
    // see the dedicated `blazor` rule below.)
    check: (info) =>
      hasCsprojSdk(info, "Microsoft.NET.Sdk.Web") ||
      hasCsprojFrameworkRef(info, "Microsoft.AspNetCore.App") ||
      hasCsprojPackage(info, "Microsoft.AspNetCore.Mvc") ||
      hasCsprojPackage(info, "Microsoft.AspNetCore.App"),
    detectedVia: ".csproj Web SDK / AspNetCore reference",
  },
  {
    id: "blazor",
    name: "Blazor",
    // `Microsoft.AspNetCore.Components[.Web|.WebView|.WebAssembly]` — covers
    // Blazor Server, WASM, and Hybrid (WebView). `hasCsprojPackage` is a prefix
    // match, so the base namespace catches every variant.
    check: (info) => hasCsprojPackage(info, "Microsoft.AspNetCore.Components"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "maui",
    name: ".NET MAUI",
    check: (info) => hasCsprojProp(info, "UseMaui") || hasCsprojPackage(info, "Microsoft.Maui"),
    detectedVia: ".csproj reference",
  },
  {
    id: "winui",
    name: "WinUI / Windows App SDK",
    check: (info) => hasCsprojPackage(info, "Microsoft.WindowsAppSDK"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "uno",
    name: "Uno Platform",
    check: (info) => hasCsprojPackage(info, "Uno.WinUI") || hasCsprojPackage(info, "Uno.UI"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "wpf",
    name: "WPF",
    check: (info) => hasCsprojProp(info, "UseWPF"),
    detectedVia: ".csproj <UseWPF>",
  },
  {
    id: "winforms",
    name: "Windows Forms",
    check: (info) => hasCsprojProp(info, "UseWindowsForms"),
    detectedVia: ".csproj <UseWindowsForms>",
  },
  {
    id: "avalonia",
    name: "Avalonia",
    check: (info) => hasCsprojPackage(info, "Avalonia"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "gtk",
    name: "GTK",
    check: (info) => hasCsprojPackage(info, "GtkSharp") || hasCsprojPackage(info, "GirCore.Gtk"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "mef",
    name: "MEF (Managed Extensibility Framework)",
    check: (info) =>
      hasCsprojPackage(info, "System.ComponentModel.Composition") ||
      hasCsprojPackage(info, "System.Composition"),
    detectedVia: ".csproj PackageReference",
  },
  // ORMs (PackageReference scanning of .csproj text)
  {
    id: "ef-core",
    name: "Entity Framework Core",
    check: (info) => hasCsprojPackage(info, "Microsoft.EntityFrameworkCore"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "ef6",
    name: "Entity Framework 6",
    check: (info) =>
      hasCsprojPackage(info, "EntityFramework") &&
      !hasCsprojPackage(info, "Microsoft.EntityFrameworkCore"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "dapper",
    name: "Dapper",
    check: (info) => hasCsprojPackage(info, "Dapper"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "nhibernate",
    name: "NHibernate",
    check: (info) => hasCsprojPackage(info, "NHibernate"),
    detectedVia: ".csproj PackageReference",
  },
];
