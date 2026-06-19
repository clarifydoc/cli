import { Command } from "commander";
import { resolve } from "path";
import { analyze } from "./core/analyzer.js";
import {
  gatherProjectInfo,
  detectFrameworksAcrossRoots,
} from "./core/framework-detector.js";
import { detectSubProjects } from "./core/project-detector.js";

const program = new Command();

program
  .name("reversedoc")
  .description(
    "Extract structured information from any codebase — routes, endpoints, data flow, components",
  )
  .version("0.1.0");

program
  .command("analyze")
  .description("Analyze a codebase and generate per-file JSON reports")
  .argument("<path>", "Path to project root")
  .option("-o, --output <dir>", "Output directory", ".reversedoc")
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

program.parse();
