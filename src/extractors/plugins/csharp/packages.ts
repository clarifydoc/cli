import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** NuGet package recognition (.NET). Plugin-owned. */
export const nugetPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["Microsoft.AspNetCore.App", "Microsoft.AspNetCore.Mvc"], category: "framework", framework: { id: "aspnet", name: "ASP.NET Core" } },
  { names: ["Microsoft.AspNetCore.Components", "Microsoft.AspNetCore.Components.WebAssembly"], category: "frontend", framework: { id: "blazor", name: "Blazor" } },
  { names: ["Microsoft.Maui.Controls", "Microsoft.Maui"], category: "frontend", framework: { id: "maui", name: ".NET MAUI" } },
  // ── ORM / data ──
  { names: ["Microsoft.EntityFrameworkCore", "Dapper", "NHibernate", "Microsoft.EntityFrameworkCore.SqlServer"], category: "orm" },
  { names: ["Npgsql", "StackExchange.Redis", "MongoDB.Driver"], category: "database" },
  // ── gRPC ──
  { names: ["Grpc.AspNetCore", "Grpc.Net.Client"], category: "grpc" },
  // ── Messaging ──
  { names: ["RabbitMQ.Client"], category: "messaging", framework: { id: "rabbitmq", name: "RabbitMQ" } },
  { names: ["Confluent.Kafka"], category: "messaging", framework: { id: "kafka", name: "Kafka" } },
  { names: ["MassTransit", "Rebus", "NServiceBus"], category: "messaging" },
  // ── Logging ──
  { names: ["Serilog", "NLog"], category: "logging" },
  // ── Serialization ──
  { names: ["Newtonsoft.Json", "System.Text.Json"], category: "serialization" },
  // ── Testing ──
  { names: ["xunit", "nunit", "Moq", "FluentAssertions", "Microsoft.NET.Test.Sdk"], category: "testing" },
  // ── Utility ──
  { names: ["AutoMapper", "MediatR", "Polly", "FluentValidation"], category: "util" },

  // ── Family patterns (lower priority than the exacts above) ──
  // Blazor's `Microsoft.AspNetCore.Components.*` (.Web, .WebView[.Wpf],
  // .WebAssembly) must be classified BEFORE the generic AspNetCore→aspnet
  // family below, or a Blazor (incl. desktop Hybrid) app reads as ASP.NET.
  { match: /^microsoft\.aspnetcore\.components/, category: "frontend", framework: { id: "blazor", name: "Blazor" } },
  { match: /^microsoft\.aspnetcore/, category: "framework", framework: { id: "aspnet", name: "ASP.NET Core" } },
  { match: /^microsoft\.extensions\.logging/, category: "logging" },
  { match: /^microsoft\.extensions\./, category: "util" },
  { match: /(^|\.)serilog/, category: "logging" },
  { match: /^awssdk\./, category: "cloud" },
  { match: /^azure\./, category: "cloud" },
  { match: /^swashbuckle/, category: "build" },
  { match: /^xunit/, category: "testing" },
];
