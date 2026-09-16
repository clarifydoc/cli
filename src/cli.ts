import { Command } from "commander";
import { resolve } from "path";
import { analyze } from "./core/analyzer.js";
import {
  gatherProjectInfo,
  detectFrameworksAcrossRoots,
} from "./core/framework-detector.js";
import { detectSubProjects } from "./core/project-detector.js";
import { gitChangedFiles } from "./core/git-changed-files.js";

const program = new Command();

program
  .name("clarifydoc")
  .description(
    "Extract structured information from any codebase — routes, endpoints, data flow, components",
  )
  .version("0.1.0");

program
  .command("analyze")
  .description("Analyze a codebase and generate per-file JSON reports")
  .argument("<path>", "Path to project root")
  .option("-o, --output <dir>", "Output directory", ".clarifydoc")
  .option("--include <globs...>", "Additional file patterns to include")
  .option("--exclude <globs...>", "Additional file patterns to exclude")
  .option("--max-files <n>", "Maximum number of files to analyze", parseInt)
  .option("--pretty", "Pretty-print JSON output", true)
  .option("--no-pretty", "Output compact JSON (no formatting)")
  .option("--verbose", "Show progress and debug info", false)
  .option("--dry-run", "List files that would be analyzed without analyzing", false)
  .option("--no-lsp", "Disable LSP-based symbol resolution")
  .option("--lsp-timeout <ms>", "Timeout for LSP server startup in ms", parseInt)
  .option("--html", "Generate an HTML report after analysis", false)
  .option("--incremental", "Reuse cached per-file analysis for unchanged files (mtime + SHA-256)", false)
  .option("--no-git-history", "Skip git churn/hotspot collection")
  .action(async (path: string, options) => {
    const projectRoot = resolve(path);
    const projectName = projectRoot.replace(/\\/g, "/").split("/").pop()!;
    const outputDir = resolve(options.output, projectName);

    if (options.verbose) {
      console.log(`Analyzing: ${projectRoot}`);
      console.log(`Output:    ${outputDir}`);
    }

    try {
      const result = await analyze({
        projectRoot,
        outputDir,
        include: options.include,
        exclude: options.exclude,
        maxFiles: options.maxFiles,
        pretty: options.pretty,
        verbose: options.verbose,
        dryRun: options.dryRun,
        lsp: options.lsp,
        lspTimeout: options.lspTimeout,
        incremental: options.incremental,
        gitHistory: options.gitHistory,
      });

      if (options.dryRun) {
        console.log(`Would analyze ${result.fileCount} files:`);
        for (const f of result.files) {
          console.log(`  ${f}`);
        }
      } else {
        console.log("Done. Analysis complete.");
        console.log(`  Files:       ${String(result.fileCount).padStart(4)}`);
        console.log(`  Elements:    ${String(result.interactiveElementCount).padStart(4)} interactive`);
        console.log(`  Screens:     ${String(result.screenCount).padStart(4)}`);
        console.log(`  Routes:      ${String(result.routeCount).padStart(4)}`);
        console.log(`  Links:       ${String(result.linkCount).padStart(4)}`);
        console.log(`  Traces:      ${String(result.symbolLinkCount).padStart(4)}`);
        if (result.healthGrade) {
          console.log(`  Health:      ${result.healthGrade.padStart(4)}`);
        }
        if (result.patternCount != null) {
          console.log(`  Patterns:    ${String(result.patternCount).padStart(4)}`);
        }
        if (result.securityIssueCount != null) {
          console.log(`  Security:    ${String(result.securityIssueCount).padStart(4)} issue(s)`);
        }
        if (result.suggestionCount != null) {
          console.log(`  Suggestions: ${String(result.suggestionCount).padStart(4)}`);
        }
        console.log(`  Output: ${outputDir}`);

        if (options.html) {
          const { generateHtmlReport } = await import("./core/html-report.js");
          const reportPath = await generateHtmlReport({
            analysisDir: outputDir,
            openBrowser: true,
          });
          console.log(`  Report: ${reportPath}`);
        }
      }
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("lsp-update")
  .description("Run LSP enhancement on an existing analysis. Writes lsp-enhancement.json alongside project-summary.json.")
  .argument("<analysis-dir>", "Path to analysis output directory (contains project-summary.json)")
  .option("--pretty", "Pretty-print JSON output", true)
  .option("--no-pretty", "Output compact JSON (no formatting)")
  .option("--verbose", "Show progress and debug info", false)
  .option("--lsp-timeout <ms>", "Timeout for LSP server startup in ms", parseInt)
  .option("--project-root <path>", "Override projectRoot (otherwise read from summary)")
  .action(async (analysisDir: string, options) => {
    try {
      const { updateLsp } = await import("./core/lsp-updater.js");
      const dir = resolve(analysisDir);
      if (options.verbose) console.log(`LSP update: ${dir}`);
      const result = await updateLsp({
        analysisDir: dir,
        projectRoot: options.projectRoot ? resolve(options.projectRoot) : undefined,
        pretty: options.pretty,
        verbose: options.verbose,
        lspTimeout: options.lspTimeout,
      });
      console.log(`Done. LSP enhancement written.`);
      console.log(`  Servers: ${result.serversUsed.join(", ") || "(none)"}`);
      console.log(`  +Defs:   ${result.lspResolvedCount}`);
      console.log(`  +Refs:   ${result.referenceLinksCount}`);
      console.log(`  Time:    ${(result.elapsedMs / 1000).toFixed(1)}s`);
      console.log(`  Output:  ${result.outputPath}`);
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("report")
  .description("Generate an HTML report from an existing analysis")
  .argument("<analysis-dir>", "Path to analysis output directory (contains project-summary.json)")
  .option("--no-open", "Don't auto-open the report in the browser")
  .action(async (analysisDir: string, options) => {
    const dir = resolve(analysisDir);
    try {
      const { generateHtmlReport } = await import("./core/html-report.js");
      const reportPath = await generateHtmlReport({
        analysisDir: dir,
        openBrowser: options.open !== false,
      });
      console.log(`Report generated: ${reportPath}`);
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("impact")
  .description(
    "Project a set of changed files onto an existing analysis: impacted screens, API routes, entities, queues and tests",
  )
  .argument("<path>", "Path to project root (a git repository unless --files is given)")
  .option("-o, --output <dir>", "Analysis output directory (same value as `analyze -o`)", ".clarifydoc")
  .option("--base <ref>", "Git ref to diff the working tree against", "HEAD")
  .option("--staged", "Use staged changes only (git diff --cached)", false)
  .option("--files <files...>", "Explicit changed-file list, project-relative (skips git)")
  .option("--json", "Print the raw JSON result", false)
  .option("--md", "Print a markdown summary (PR-comment ready)", false)
  .action(async (path: string, options) => {
    const projectRoot = resolve(path);
    const projectName = projectRoot.replace(/\\/g, "/").split("/").pop()!;
    const analysisDir = resolve(options.output, projectName);
    try {
      const { loadReportSummary } = await import("./core/report-payload.js");
      let summary;
      try {
        summary = await loadReportSummary(analysisDir);
      } catch {
        throw new Error(
          `No analysis found at ${analysisDir}.\n` +
            `Run first: clarifydoc analyze ${path} -o ${options.output} --incremental`,
        );
      }

      let changed: string[];
      let label: string;
      if (options.files?.length) {
        changed = options.files;
        label = "--files";
      } else {
        ({ files: changed, label } = await gitChangedFiles(projectRoot, {
          base: options.base,
          staged: options.staged,
        }));
      }

      const { computeImpactDiff, renderImpactText, renderImpactMarkdown } = await import(
        "./core/impact-diff.js"
      );
      const impact = computeImpactDiff(summary, changed, { baseLabel: label });
      if (options.json) console.log(JSON.stringify(impact, null, 2));
      else if (options.md) console.log(renderImpactMarkdown(impact));
      else console.log(renderImpactText(impact));
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("detect")
  .description("Detect languages and frameworks in a project")
  .argument("<path>", "Path to project root")
  .action(async (path: string) => {
    const projectRoot = resolve(path);
    const info = await gatherProjectInfo(projectRoot);

    // Frameworks are detected across the analyzed root AND every sub-project
    // root — build manifests in a monorepo (a Flutter `pubspec.yaml`, a nested
    // `package.json`/`pom.xml`) live below the root, so a root-only scan misses
    // them. This mirrors what `analyze` records in `detectedFrameworks`.
    const subProjects = await detectSubProjects(projectRoot);
    const { merged: frameworks } = await detectFrameworksAcrossRoots(
      projectRoot,
      subProjects.map((s) => s.root),
    );

    console.log("Project info:");
    console.log(`  Root: ${projectRoot}`);
    console.log(
      `  File extensions: ${[...info.fileExtensions].sort().join(", ")}`,
    );

    if (frameworks.length === 0) {
      console.log("  No frameworks detected.");
    } else {
      console.log("  Detected frameworks:");
      for (const fw of frameworks) {
        console.log(`    - ${fw.name} (${fw.detectedVia})`);
      }
    }
  });

program
  .command("schema")
  .description("Print the JSON output schema")
  .action(() => {
    console.log(
      JSON.stringify(
        {
          $schema: "FileAnalysis",
          fields: [
            "filePath",
            "language",
            "frameworks",
            "imports",
            "exports",
            "functions",
            "classes",
            "routes",
            "dataSources",
            "dataMutations",
            "subComponents",
            "interactiveElements",
          ],
        },
        null,
        2,
      ),
    );
  });

program
  .command("mcp")
  .description(
    "Serve the analysis to an AI agent over the Model Context Protocol (stdio). Used by the VS Code extension and by any MCP client.",
  )
  .argument("[path]", "Path to project root. Omit to use the project containing the working directory", "")
  .option("-o, --output <dir>", "Analysis output directory (same value as `analyze -o`)", ".clarifydoc")
  .option(
    "--analysis-dir <dir>",
    "Exact directory containing project-summary.json (overrides --output; what the VS Code extension passes)",
  )
  .option(
    "--no-auto-analyze",
    "Do not re-analyze on request. The first analysis still runs when the project has none — pass --no-cold-start to forbid that too",
  )
  .option("--no-cold-start", "Never analyze, not even when no analysis exists yet")
  .option("--lsp", "Allow the optional LSP enhancement when this server runs an analysis (needs Docker)", false)
  .option("--no-git-history", "Skip git churn/hotspot collection when this server runs an analysis")
  .option("--max-files <n>", "Maximum number of files to analyze", parseInt)
  .option("--include <globs...>", "Additional file patterns to include")
  .option("--exclude <globs...>", "Additional file patterns to exclude")
  .action(async (path: string, options) => {
    // Nothing may write to stdout from here on — it is the JSON-RPC wire.
    const { startMcpServer, findProjectRoot } = await import("./mcp/server.js");
    try {
      await startMcpServer({
        // With no path given, serve the project the working directory sits in,
        // so an argument-free client config works from anywhere inside it.
        projectRoot: path ? resolve(path) : findProjectRoot(process.cwd()),
        analysisDir: options.analysisDir,
        outputBase: options.output,
        allowAnalyze: options.autoAnalyze !== false,
        allowColdStart: options.coldStart !== false,
        version: program.version() ?? undefined,
        analyzeSettings: {
          incremental: true,
          lsp: options.lsp === true,
          gitHistory: options.gitHistory,
          maxFiles: options.maxFiles,
          include: options.include,
          exclude: options.exclude,
        },
      });
    } catch (err) {
      process.stderr.write(`[clarifydoc-mcp] fatal: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

// `from: "node"` explicitly. Commander otherwise sniffs `process.versions.electron`
// and treats argv as Electron-style (script path NOT skipped) — but the VS Code
// extension runs this very file on VS Code's own runtime with
// ELECTRON_RUN_AS_NODE=1 when the machine has no Node, where argv IS
// node-shaped. Without this, that fallback fails with "unknown command
// '…/cli.js'".
program.parse(process.argv, { from: "node" });
