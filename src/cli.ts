import { Command } from "commander";
import { resolve } from "path";
import { analyze } from "./core/analyzer.js";
import {
  gatherProjectInfo,
  detectFrameworks,
} from "./core/framework-detector.js";

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
      });

      if (options.dryRun) {
        console.log(`Would analyze ${result.fileCount} files:`);
        for (const f of result.files) {
          console.log(`  ${f}`);
        }
      } else {
        console.log(
          `Done. Analyzed ${result.fileCount} files. Output: ${outputDir}`,
        );
      }
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
    const frameworks = detectFrameworks(info);

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
            "analyzedAt",
            "imports",
            "exports",
            "functions",
            "classes",
            "routes",
            "dataSources",
            "dataMutations",
            "subComponents",
          ],
        },
        null,
        2,
      ),
    );
  });

program.parse();
