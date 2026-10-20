import { Command, InvalidArgumentError } from "commander";
import { TOOL_VERSION } from "./core/version.js";
import { resolve, relative, join, basename, dirname } from "path";
import { existsSync } from "fs";
import { analyze } from "./core/analyzer.js";
import {
  gatherProjectInfo,
  detectFrameworksAcrossRoots,
} from "./core/framework-detector.js";
import { detectSubProjects } from "./core/project-detector.js";
import { EXTENSION_TO_LANGUAGE, NAMED_FILE_LANGUAGE } from "./extractors/registry.js";
import { gitChangedFiles, gitChangedHunks, gitUserName } from "./core/git-changed-files.js";
import {
  controlFlowForFile,
  controlFlowCapabilities,
  ControlFlowUnavailableError,
} from "./core/control-flow-file.js";
import { toMermaidFlowchart, toMarkdown } from "./core/control-flow-mermaid.js";

/** All of stdin, as UTF-8 text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** A whole number ≥ `min` — `parseInt` alone turns "abc" into NaN, which silently disabled the bound it set. */
const wholeNumber = (min = 0) => (value: string): number => {
  if (!/^\d+$/.test(value.trim()) || Number(value) < min) throw new InvalidArgumentError(`Expected a whole number${min ? ` ≥ ${min}` : ""}.`);
  return Number(value);
};

const program = new Command();

program
  .name("clarifydoc")
  .description(
    "Extract structured information from any codebase — routes, endpoints, data flow, components",
  )
  .version(TOOL_VERSION);

program
  .command("analyze")
  .description("Analyze a codebase and generate per-file JSON reports")
  .argument("<path>", "Path to project root")
  .option("-o, --output <dir>", "Output directory", ".clarifydoc")
  .option("--include <globs...>", "Additional file patterns to include")
  .option("--exclude <globs...>", "Additional file patterns to exclude")
  .option("--max-files <n>", "Maximum number of files to analyze", wholeNumber(1))
  .option("--pretty", "Pretty-print JSON output", true)
  .option("--no-pretty", "Output compact JSON (no formatting)")
  .option("--verbose", "Show progress and debug info", false)
  .option("--dry-run", "List files that would be analyzed without analyzing", false)
  .option("--no-lsp", "Disable LSP-based symbol resolution")
  .option("--lsp-timeout <ms>", "Timeout for LSP server startup in ms", wholeNumber())
  .option("--html", "Generate an HTML report after analysis", false)
  .option("--sarif <file>", "Also write the findings as SARIF 2.1.0 (GitHub code scanning): security, request contracts, calls that reach no route, forbidden imports, performance, dead code")
  .option("--junit <file>", "Also write the findings as a JUnit XML report (one test case per rule)")
  .option("--codequality <file>", "Also write the findings as a GitLab Code Quality report")
  .option("--progress <format>", "Report progress as `json`: one event per line on stderr (stage, files done, done) instead of the status line")
  .option("--fail-on <gate>", "Exit with code 2 when a finding matches: a level (error | warning | note), finding categories (security, contract, route-miss, performance, dead-code, a rule id…), or both, comma-separated")
  .option("--baseline <sarif-or-analysis>", "Findings of the base (its SARIF, or its analysis directory): reports mark each finding new or unchanged, and --fail-on counts only new ones")
  .option("--import-sarif <files...>", "Join other tools' SARIF findings (Semgrep, CodeQL, gosec…) to the map: each gets the routes that reach it")
  .option("--spec <files...>", "API specs outside the tree (an OpenAPI document the backend publishes) to check the code's calls against")
  .option("--history-secrets", "Also read every commit's added lines for credentials (cloud keys, tokens, private keys): a key deleted from the tree is still in every clone")
  .option("--coverage <files...>", "Test coverage reports (lcov, Cobertura, JaCoCo, Clover, Go coverprofile); without it the usual report paths are tried")
  .option("--osv", "Check the installed package versions against OSV (api.osv.dev) — a network call", false)
  .option("--incremental", "Reuse cached per-file analysis for unchanged files (mtime + SHA-256)", false)
  .option("--no-git-history", "Skip git churn/hotspot collection")
  .option(
    "--stable-output",
    "Write a fixed timestamp and a relative project root, so repeated runs produce identical artifacts (for committed fixtures)",
  )
  .action(async (path: string, options) => {
    const projectRoot = resolve(path);
    const projectName = projectRoot.replace(/\\/g, "/").split("/").pop()!;
    const outputDir = resolve(options.output, projectName);

    if (options.verbose) {
      console.log(`Analyzing: ${projectRoot}`);
      console.log(`Output:    ${outputDir}`);
    }

    try {
      if (options.progress !== undefined && options.progress !== "json") throw new Error(`--progress takes json, not "${options.progress}"`);
      const progressJson = options.progress === "json";
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
        ...(options.importSarif ? { importSarif: (options.importSarif as string[]).map((f) => resolve(f)) } : {}),
        ...(options.spec ? { specs: (options.spec as string[]).map((f) => resolve(f)) } : {}),
        ...(options.coverage ? { coverage: (options.coverage as string[]).map((f) => resolve(f)) } : {}),
        ...(options.historySecrets ? { historySecrets: true } : {}),
        osv: options.osv,
        stableOutput: options.stableOutput,
        ...(progressJson ? { onProgress: (e: object) => process.stderr.write(JSON.stringify(e) + "\n") } : {}),
      });

      if (options.dryRun) {
        console.log(`Would analyze ${result.fileCount} files:`);
        for (const f of result.files) {
          console.log(`  ${f}`);
        }
      } else {
        console.log(
          result.upToDate
            ? "Up to date: nothing changed since the last run, so nothing was rebuilt."
            : result.docsOnly
              ? "Done. Only documentation changed: doc drift re-checked, the rest kept from the last run."
              : "Done. Analysis complete.",
        );
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

        let failed = 0;
        if (options.sarif || options.failOn || options.junit || options.codequality) {
          const [{ loadReportSummary }, sarifLib, { TOOL_VERSION }, { writeFile, readFile, stat }] = await Promise.all([
            import("./core/report-payload.js"),
            import("./core/sarif.js"),
            import("./core/version.js"),
            import("fs/promises"),
          ]);
          const { buildSarif, structuralFindings, parseFailOn, isKnownCategory, failingResults, applyBaseline, sarifToJunit, sarifToCodeQuality } = sarifLib;
          // Refuse a gate it cannot honour before reporting anything.
          const gate = options.failOn ? parseFailOn(String(options.failOn)) : undefined;
          const { SECURITY_CATEGORIES, ruleIdOf } = await import("./core/security-rules.js");
          const summary = await loadReportSummary(outputDir);
          const sarif = buildSarif(summary.securityIssues ?? [], TOOL_VERSION, structuralFindings(summary));
          const ruleIds = [...SECURITY_CATEGORIES.map(ruleIdOf), ...sarifLib.STRUCTURAL_RULE_IDS];
          const unknown = (gate?.categories ?? []).filter((c) => !isKnownCategory(c, ruleIds));
          if (unknown.length) throw new Error(`--fail-on: unknown categor${unknown.length === 1 ? "y" : "ies"} ${unknown.join(", ")}`);
          if (options.baseline) {
            let base = resolve(String(options.baseline));
            // `-o base` writes base/<project>/: accept the directory given to -o as well.
            if ((await stat(base)).isDirectory() && !existsSync(join(base, "project-summary.json")) && existsSync(join(base, basename(outputDir), "project-summary.json"))) {
              base = join(base, basename(outputDir));
            }
            const baseLog = (await stat(base)).isDirectory()
              ? (() => loadReportSummary(base).then((b) => buildSarif(b.securityIssues ?? [], TOOL_VERSION, structuralFindings(b))))()
              : readFile(base, "utf8").then((t) => JSON.parse(t));
            const fresh = applyBaseline(sarif, await baseLog);
            console.log(`  Baseline: ${fresh} new finding(s), ${sarif.runs[0]!.results.length - fresh} also in the base`);
          }
          if (options.sarif) {
            await writeFile(resolve(options.sarif), JSON.stringify(sarif, null, 2));
            console.log(`  SARIF:  ${resolve(options.sarif)} (${sarif.runs[0]!.results.length} result(s))`);
          }
          if (options.junit) {
            await writeFile(resolve(options.junit), sarifToJunit(sarif, gate ?? {}));
            console.log(`  JUnit:  ${resolve(options.junit)}`);
          }
          if (options.codequality) {
            await writeFile(resolve(options.codequality), sarifToCodeQuality(sarif));
            console.log(`  Code Quality: ${resolve(options.codequality)}`);
          }
          if (gate) {
            failed = failingResults(sarif, gate).length;
            const what = [gate.categories?.join(", "), gate.level && `${gate.level} or above`].filter(Boolean).join(", at ");
            console.log(`  Fail-on: ${failed}${options.baseline ? " new" : ""} finding(s) — ${what}`);
          }
        }

        if (options.html) {
          const { generateHtmlReport } = await import("./core/html-report.js");
          const reportPath = await generateHtmlReport({
            analysisDir: outputDir,
            openBrowser: true,
          });
          console.log(`  Report: ${reportPath}`);
        }
        // 2, not 1: a gate that tripped, as opposed to an analysis that failed.
        if (failed > 0) process.exitCode = 2;
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
  .option("--lsp-timeout <ms>", "Timeout for LSP server startup in ms", wholeNumber())
  .option("--project-root <path>", "Override projectRoot (otherwise read from summary)")
  .option("--emit-queries <file>", "Write the definition questions to <file> and stop (no server starts) — for an editor to answer")
  .option("--answers <file>", "Take definitions from <file> (answers to --emit-queries) instead of the Docker servers")
  .option("--scip <file>", "Take definitions from a SCIP index (index.scip from scip-typescript, scip-java, …) instead of the Docker servers")
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
        ...(options.emitQueries ? { emitQueries: options.emitQueries } : {}),
        ...(options.answers ? { answers: options.answers } : {}),
        ...(options.scip ? { scip: options.scip } : {}),
      });
      if (result.source === "queries") {
        console.log(`Done. ${result.queryCount} definition queries written to ${result.outputPath}`);
        return;
      }
      console.log(`Done. LSP enhancement written.`);
      console.log(`  Source:  ${result.source}${result.abstained ? ` (${result.abstained} ambiguous answers abstained)` : ""}`);
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
  .option("--editor-scheme <scheme>", "URL scheme file links open in: vscode (default), cursor, windsurf, vscodium, …")
  .action(async (analysisDir: string, options) => {
    const dir = resolve(analysisDir);
    try {
      const { generateHtmlReport } = await import("./core/html-report.js");
      const reportPath = await generateHtmlReport({
        analysisDir: dir,
        openBrowser: options.open !== false,
        editorScheme: options.editorScheme,
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
  .option("--author <name>", "The change's author, left out of the suggested reviewers (default: git config user.name)")
  .option("--analysis-dir <dir>", "Exact directory containing project-summary.json (overrides --output)")
  .option("--baseline <dir>", "An analysis of the base (another checkout's or worktree's): also diff the API surface against it")
  .action(async (path: string, options) => {
    const projectRoot = resolve(path);
    const projectName = projectRoot.replace(/\\/g, "/").split("/").pop()!;
    const analysisDir = options.analysisDir ? resolve(options.analysisDir) : resolve(options.output, projectName);
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
      const author = options.author ?? (options.files?.length ? undefined : await gitUserName(projectRoot));
      // The diff's lines, so the change is also judged function by function.
      let symbols: { changed: import("./core/changed-symbols.js").ChangedSymbol[]; moduleLevel: string[]; signatureChanges?: import("./core/changed-symbols.js").SignatureChange[]; hunks?: import("./core/changed-symbols.js").ChangedHunks } | undefined;
      if (!options.files?.length) {
        try {
          const { symbolsInHunks, loadFileAnalyses, analyzeWorkingFiles, signatureChanges } = await import("./core/changed-symbols.js");
          const hunks = await gitChangedHunks(projectRoot, { base: options.base, staged: options.staged });
          const touched = [...new Set([...hunks.keys(), ...changed])];
          const before = await loadFileAnalyses(analysisDir, touched);
          const found = symbolsInHunks(before, hunks);
          const after = await analyzeWorkingFiles(projectRoot, [...before.keys()]);
          symbols = { changed: found.symbols, moduleLevel: found.moduleLevel, signatureChanges: signatureChanges(before, after, summary.symbolLinks ?? []), hunks };
        } catch (e) {
          // No line ranges: the file-level impact stands alone.
          if (process.env.CLARIFYDOC_DEBUG) console.error(e);
        }
      }
      const impact = computeImpactDiff(summary, changed, { baseLabel: label, ...(author ? { author } : {}), ...(symbols ? { symbols } : {}) });
      let surface: import("./core/surface-diff.js").SurfaceDiff | undefined;
      const sd = options.baseline ? await import("./core/surface-diff.js") : null;
      if (sd) surface = sd.diffSurface(await loadAnalysisAt(options.baseline, options.output), summary);
      if (options.json) console.log(JSON.stringify(surface ? { ...impact, surface } : impact, null, 2));
      else if (options.md) console.log(renderImpactMarkdown(impact) + (surface ? `\n${sd!.renderSurfaceMarkdown(surface, { base: "baseline", head: "working tree" })}` : ""));
      else console.log(renderImpactText(impact) + (surface ? `\n${sd!.renderSurfaceText(surface)}` : ""));
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("detect")
  .description(
    "Detect languages and frameworks in a project. With --json and no path, print only " +
      "what the analyzer can read (its file extensions and extension-less file names), without scanning",
  )
  .argument("[path]", "Path to project root")
  .option("--json", "Print JSON instead of text")
  .action(async (path: string | undefined, opts: { json?: boolean }) => {
    // What discovery picks up — the same tables it globs by — so a caller that
    // watches for changes (the VS Code extension) never keeps its own list.
    const analyzable = {
      analyzableExtensions: Object.keys(EXTENSION_TO_LANGUAGE).sort(),
      namedFiles: [...NAMED_FILE_LANGUAGE.keys()].sort(),
    };
    if (path === undefined) {
      if (!opts.json) {
        console.error("detect: a project path is required (or pass --json for the analyzable file types).");
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(analyzable, null, 2));
      return;
    }

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

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            root: projectRoot,
            fileExtensions: [...info.fileExtensions].sort(),
            frameworks: frameworks.map((fw) => ({ name: fw.name, detectedVia: fw.detectedVia })),
            ...analyzable,
          },
          null,
          2,
        ),
      );
      return;
    }

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
  .description("Print the fields of the per-file JSON and of project-summary.json")
  .action(async () => {
    const { outputSchema } = await import("./core/output-schema.js");
    console.log(JSON.stringify(outputSchema(), null, 2));
  });

program
  .command("cfg")
  .description(
    "Print the control flow of one function as a Mermaid flowchart — the structure behind its complexity number. Reads a single file; writes nothing",
  )
  .argument("[file]", "Path to the source file")
  .option("-f, --function <name>", "Function to draw (`Class.method` or the bare method name)")
  .option("-l, --line <n>", "Draw the function whose body covers this 1-based line", wholeNumber(1))
  .option("--format <format>", "mermaid | markdown | json", "mermaid")
  .option("--slice <line>", "Instead of the graph: the statements that can affect the values used at this line (backward slice)", wholeNumber(1))
  .option("--stdin", "Read the file's text from stdin (an editor's unsaved buffer); <file> still names the file and its language")
  .option(
    "--no-styled",
    "Leave the colour table out of the Mermaid, keeping only the category classes — for a host that themes the diagram itself",
  )
  .option(
    "--capabilities",
    "Print the languages and file extensions that can have a control-flow graph drawn, as JSON, and exit",
  )
  .action(async (file: string | undefined, options) => {
    if (options.capabilities) {
      console.log(JSON.stringify(await controlFlowCapabilities()));
      return;
    }
    if (!file) {
      console.error("Missing <file>. Pass --capabilities to list the supported languages.");
      process.exitCode = 1;
      return;
    }
    const target = resolve(file);
    const source = options.stdin ? await readStdin() : undefined;
    try {
      const result = await controlFlowForFile({
        filePath: target,
        displayPath: relative(process.cwd(), target) || file,
        functionName: options.function,
        line: Number.isFinite(options.line) ? options.line : undefined,
        source,
      });

      const listFunctions = (): void => {
        if (result.available.length === 0) return;
        console.error("Functions in this file:");
        for (const fn of result.available) {
          console.error(`  ${fn.functionName}  (lines ${fn.line}-${fn.endLine}, complexity ${fn.complexity})`);
        }
      };

      if (result.cfgs.length === 0) {
        console.error(
          options.function || options.line
            ? `No function matched in ${file}.`
            : `Nothing in ${file} has a body to draw.`,
        );
        listFunctions();
        process.exitCode = 1;
        return;
      }

      if (Number.isFinite(options.slice)) {
        const sliceLine = options.slice as number;
        const cfg = result.cfgs.find((c) => c.line <= sliceLine && sliceLine <= c.endLine) ?? (result.cfgs.length === 1 ? result.cfgs[0] : undefined);
        if (!cfg) {
          console.error(`Line ${sliceLine} is in none of the functions drawn — name the one it is in with --function or --line.`);
          listFunctions();
          process.exitCode = 1;
          return;
        }
        const { backwardSlice } = await import("./core/control-flow-slice.js");
        const { readFile } = await import("fs/promises");
        const slice = backwardSlice(cfg, (source ?? (await readFile(target, "utf-8"))).split(/\r?\n/), sliceLine);
        if (!slice) {
          console.error(`No statement of ${cfg.functionName} covers line ${sliceLine}.`);
          process.exitCode = 1;
          return;
        }
        if (options.format === "json") {
          console.log(JSON.stringify({ filePath: result.filePath, functionName: cfg.functionName, approximate: cfg.approximate === true, ...slice }, null, 2));
          return;
        }
        console.log(`Backward slice of ${cfg.functionName} at line ${sliceLine}${slice.variables.length ? ` — values: ${slice.variables.join(", ")}` : ""}${cfg.approximate ? " (approximate graph)" : ""}`);
        const width = String(Math.max(...slice.statements.map((s) => s.line), 1)).length;
        for (const s of slice.statements) {
          const first = s.text.split("\n")[0]!;
          console.log(`  ${String(s.line).padStart(width)}  ${first}${s.text.includes("\n") ? " …" : ""}  (${s.why})`);
        }
        if (slice.fromOutside.length) console.log(`From parameters or the enclosing scope: ${slice.fromOutside.join(", ")}`);
        return;
      }

      // Several flowcharts concatenated are not one Mermaid document, so the
      // raw format draws exactly one function. Markdown and JSON are containers
      // and can hold the whole file.
      if (options.format === "mermaid" && result.cfgs.length > 1) {
        console.error(
          `${file} has ${result.cfgs.length} functions — name one with --function or --line, or use --format markdown for all of them.`,
        );
        listFunctions();
        process.exitCode = 1;
        return;
      }

      // JSON carries the graph AND its rendering: a caller that wants to draw
      // the diagram should not have to re-implement the renderer, and one that
      // wants to navigate it needs the per-node source lines the Mermaid text
      // has no room for.
      if (options.format === "json") {
        console.log(
          JSON.stringify(
            {
              filePath: result.filePath,
              language: result.language,
              diagrams: result.cfgs.map((cfg) => {
                const diagram = toMermaidFlowchart(cfg, { classDefs: options.styled });
                return { cfg, mermaid: diagram.text, note: diagram.note };
              }),
            },
            null,
            2,
          ),
        );
        return;
      }
      for (const cfg of result.cfgs) {
        if (options.format === "markdown") {
          console.log(toMarkdown(cfg));
          continue;
        }
        const diagram = toMermaidFlowchart(cfg, { classDefs: options.styled });
        console.log(diagram.text);
        // The note goes to stderr so `clarifydoc cfg … > flow.mmd` stays valid
        // Mermaid while the caveats still reach a human at a terminal.
        if (diagram.note) console.error(`note: ${diagram.note}.`);
      }
    } catch (error) {
      if (error instanceof ControlFlowUnavailableError) {
        console.error(error.message);
      } else {
        console.error("Failed to build control flow:", error instanceof Error ? error.message : error);
      }
      process.exitCode = 1;
    }
  });

program
  .command("seq")
  .description("Draw what a route (or a function) does, in order, as a Mermaid sequence diagram: calls, data access, HTTP hops to other tiers")
  .argument("<path>", "Path to project root")
  .option("--route <route>", 'The route, e.g. "POST /api/orders" (a path alone when it is unique)')
  .option("--symbol <symbol>", 'A function or method instead, e.g. "OrderService.create"')
  .option("--file <file>", "The file that declares the route or symbol, when the name is not unique")
  .option("--depth <n>", "Hops of calls to follow (default 8)", wholeNumber())
  .option("-o, --output <dir>", "Analysis output directory (same value as `analyze -o`)", ".clarifydoc")
  .option("--analysis-dir <dir>", "Exact directory containing project-summary.json (overrides --output)")
  .action(async (path: string, options) => {
    const projectRoot = resolve(path);
    const projectName = projectRoot.replace(/\\/g, "/").split("/").pop()!;
    const analysisDir = options.analysisDir ? resolve(options.analysisDir) : resolve(options.output, projectName);
    try {
      const { loadReportSummary } = await import("./core/report-payload.js");
      const { buildSequence, findRoutes, routeAnchor } = await import("./core/sequence.js");
      let summary;
      try {
        summary = await loadReportSummary(analysisDir);
      } catch {
        throw new Error(`No analysis found at ${analysisDir}.\nRun first: clarifydoc analyze ${path} -o ${options.output}`);
      }
      const depth = options.depth ? { depth: options.depth as number } : {};
      if (options.route) {
        const found = findRoutes(summary.routeMap ?? [], options.route, options.file);
        if (found.length !== 1) {
          throw new Error(found.length === 0 ? `No route matches "${options.route}"` : `"${options.route}" matches ${found.length} routes — pass the method, or --file:\n${found.slice(0, 15).map((r) => `  ${r.httpMethod ?? ""} ${r.path}  (${r.filePath}:${r.line})`).join("\n")}`);
        }
        const r = found[0]!;
        const anchor = routeAnchor(r, summary.symbolLinks ?? []);
        if (!anchor) throw new Error(`${r.httpMethod ?? ""} ${r.path} calls nothing the analysis resolved`);
        process.stdout.write(buildSequence(summary, { file: r.filePath!, symbol: anchor, title: `${r.httpMethod ? `${r.httpMethod.toUpperCase()} ` : ""}${r.path}` }, depth));
        return;
      }
      if (!options.symbol) throw new Error("Pass --route or --symbol");
      const defs = [...new Set((summary.symbolLinks ?? []).filter((l) => l.sourceSymbol === options.symbol && (!options.file || l.sourceFile.includes(options.file))).map((l) => l.sourceFile))];
      if (defs.length !== 1) throw new Error(defs.length === 0 ? `${options.symbol} calls nothing the analysis resolved` : `${options.symbol} is declared in ${defs.length} files — pass --file:\n${defs.map((f) => `  ${f}`).join("\n")}`);
      process.stdout.write(buildSequence(summary, { file: defs[0]!, symbol: options.symbol, title: options.symbol }, depth));
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("export")
  .description("Render an analysis as committed artifacts: ARCHITECTURE.md, DATA-MODEL.md, FLOWS.md, Mermaid diagrams, GraphML, Cypher, CSV, an Obsidian vault")
  .argument("<path>", "Path to project root")
  .option("-o, --output <dir>", "Analysis output directory (same value as `analyze -o`)", ".clarifydoc")
  .option("--analysis-dir <dir>", "Exact directory containing project-summary.json (overrides --output)")
  .option("--format <names...>", "Formats to render (file names, e.g. ARCHITECTURE.md er.mmd files.graphml); default: the three Markdown documents")
  .option("--out-dir <dir>", "Write the files here (default: print one format to stdout, or write several to the current directory)")
  .option("--list", "List the formats", false)
  .action(async (path: string, options) => {
    const { EXPORT_BUNDLES, EXPORT_FORMATS, findExportBundle, renderExport } = await import("./export/index.js");
    if (options.list) {
      for (const f of EXPORT_FORMATS) console.log(`${f.name.padEnd(22)} ${f.description}`);
      for (const b of EXPORT_BUNDLES) console.log(`${`${b.name}/`.padEnd(22)} ${b.description}`);
      return;
    }
    const projectRoot = resolve(path);
    const projectName = projectRoot.replace(/\\/g, "/").split("/").pop()!;
    const analysisDir = options.analysisDir ? resolve(options.analysisDir) : resolve(options.output, projectName);
    try {
      const { loadReportSummary } = await import("./core/report-payload.js");
      let summary;
      try {
        summary = await loadReportSummary(analysisDir);
      } catch {
        throw new Error(`No analysis found at ${analysisDir}.\nRun first: clarifydoc analyze ${path} -o ${options.output}`);
      }
      const names: string[] = options.format ?? ["ARCHITECTURE.md", "DATA-MODEL.md", "FLOWS.md"];
      if (names.length === 1 && !options.outDir && !findExportBundle(names[0]!)) {
        process.stdout.write(renderExport(names[0]!, summary));
        return;
      }
      const { mkdir, writeFile } = await import("fs/promises");
      const dir = resolve(options.outDir ?? ".");
      await mkdir(dir, { recursive: true });
      for (const name of names) {
        const bundle = findExportBundle(name);
        if (bundle) {
          const root = resolve(dir, bundle.name);
          const files = bundle.render(summary as never);
          for (const f of files) {
            await mkdir(dirname(resolve(root, f.path)), { recursive: true });
            await writeFile(resolve(root, f.path), f.content);
          }
          console.log(`wrote ${root}/ (${files.length} files)`);
          continue;
        }
        const file = resolve(dir, name);
        await writeFile(file, renderExport(name, summary));
        console.log(`wrote ${file}`);
      }
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("hook")
  .description("Agent-host hook (Claude Code protocol): reads the hook payload on stdin, prints context from the analysis. Wired by `clarifydoc install --hooks`")
  .argument("<event>", "pre-search | post-edit | session-start")
  .action(async (event: string) => {
    // A hook must never stand in the agent's way: any failure is silence.
    try {
      const { HOOK_EVENTS, runHook, readHookInput } = await import("./agents/hooks.js");
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) return;
      const timer = setTimeout(() => process.exit(0), 8000);
      const out = await runHook(event as never, readHookInput());
      clearTimeout(timer);
      if (out) process.stdout.write(out + "\n");
    } catch {
      /* silent */
    }
  });

program
  .command("install")
  .description("Wire ClarifyDoc into agent hosts: the MCP server entry, Claude Code hooks, skills, and the AGENTS.md section")
  .argument("[path]", "Project root", ".")
  .option("--client <names...>", "claude-code | cursor | vscode | windsurf | gemini | codex | claude-desktop | zed | opencode | cline (default claude-code)")
  .option("--hooks", "Also add Claude Code hooks (.claude/settings.json): context before searches, after edits, at session start", false)
  .option("--skills", "Also write .claude/skills/clarifydoc-* from the MCP workflow prompts", false)
  .option("--guidance [file]", "Also add or update the ClarifyDoc section of AGENTS.md (or the file named)")
  .option("--git-hooks", "Also add git hooks (post-commit, post-merge, post-checkout) that refresh the analysis in the background", false)
  .option("-o, --output <dir>", "Analysis output directory, for the project facts in the guidance", ".clarifydoc")
  .option("--print", "Print what would be written instead of writing it", false)
  .option("--command <launcher>", "Start ClarifyDoc with this command in the entries and hooks written (default: the way this CLI was started)")
  .option("--no-mcp", "Write no MCP server entry — only the hooks, skills, guidance or git hooks asked for")
  .option("--plugin <dir>", "Write a Claude Code plugin into <dir> instead: the MCP server entry, the skills and an explorer subagent")
  .action(async (path: string, options) => {
    const root = resolve(path);
    const { CLIENTS, applyPlans, planClaudeHooks, planGitHooks, planGuidance, planMcpConfig, planPlugin, planSkills, projectFacts, selfCommand } = await import("./agents/install.js");
    // A launcher that outlives this install (an editor's stable shim) instead of this process's own path.
    const self = options.command ? { command: options.command as string, args: [] } : selfCommand();
    if (options.plugin) {
      const { buildMcpServer } = await import("./mcp/server.js");
      const { tools } = buildMcpServer({ projectRoot: root, allowAnalyze: false, allowColdStart: false });
      for (const line of applyPlans(planPlugin(resolve(options.plugin), tools, self), options.print)) console.log(line);
      return;
    }
    const clients = (options.client as string[] | undefined) ?? ["claude-code"];
    const unknown = clients.filter((c) => !(CLIENTS as readonly string[]).includes(c));
    if (unknown.length) {
      console.error(`Unknown client(s): ${unknown.join(", ")}. Known: ${CLIENTS.join(", ")}.`);
      process.exitCode = 1;
      return;
    }
    // `install --git-hooks` alone is about git, not an agent host: no MCP entry unless a client is named.
    const gitOnly = options.gitHooks && !options.client && !options.hooks && !options.skills && !options.guidance;
    const plans = gitOnly || options.mcp === false ? [] : clients.map((c) => planMcpConfig(c as never, root, self));
    if (options.hooks) plans.push(planClaudeHooks(root, self));
    if (options.skills) plans.push(...planSkills(root));
    if (options.gitHooks) {
      try {
        plans.push(...planGitHooks(root, { output: options.output }, self));
      } catch {
        console.error(`${root} is not a git repository: --git-hooks needs one.`);
        process.exitCode = 1;
        return;
      }
    }
    if (options.guidance) {
      let facts: string[] = [];
      try {
        const { loadReportSummary } = await import("./core/report-payload.js");
        const name = root.replace(/\\/g, "/").split("/").pop()!;
        facts = projectFacts(await loadReportSummary(resolve(root, options.output, name)));
      } catch {
        // No analysis yet: the generic section alone.
      }
      plans.push(planGuidance(root, typeof options.guidance === "string" ? options.guidance : "AGENTS.md", facts));
    }
    for (const line of applyPlans(plans, options.print)) console.log(line);
  });

program
  .command("diff")
  .description("Diff the API surface of two analyses: routes, parameters, request bodies, guards, versions, cross-tier links, data reached, and the import cycles the head introduced")
  .argument("<base>", "The base analysis: a directory holding project-summary.json, or a project root (its -o analysis is used)")
  .argument("<head>", "The head analysis, the same way")
  .option("-o, --output <dir>", "Analysis output directory for a project-root argument (same value as `analyze -o`)", ".clarifydoc")
  .option("--json", "Print the raw JSON result", false)
  .option("--md", "Print markdown (PR-comment ready)", false)
  .option("--fail-on <level>", "Exit with code 2 when a change at this level exists: breaking | risky")
  .action(async (base: string, head: string, options) => {
    try {
      if (options.failOn && options.failOn !== "breaking" && options.failOn !== "risky") throw new Error("--fail-on is breaking or risky");
      const { diffSurface, renderSurfaceMarkdown, renderSurfaceText } = await import("./core/surface-diff.js");
      const d = diffSurface(await loadAnalysisAt(base, options.output), await loadAnalysisAt(head, options.output));
      if (options.json) console.log(JSON.stringify(d, null, 2));
      else if (options.md) process.stdout.write(renderSurfaceMarkdown(d, { base, head }));
      else process.stdout.write(renderSurfaceText(d));
      if (options.failOn === "breaking" && d.counts.breaking > 0) process.exitCode = 2;
      if (options.failOn === "risky" && d.counts.breaking + d.counts.risky > 0) process.exitCode = 2;
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("ask")
  .description("Call one MCP tool from a shell or CI and print its answer: clarifydoc ask routes path=/api/users")
  .argument("[tool]", "Tool name, with or without the clarifydoc_ prefix (routes, trace, impact, …)")
  .argument("[args...]", "Arguments as key=value (a value that reads as JSON — 3, true, [..] — is taken as such)")
  .option("-p, --project <path>", "Project root (default: the project containing the working directory)")
  .option("-o, --output <dir>", "Analysis output directory (same value as `analyze -o`)", ".clarifydoc")
  .option("--analysis-dir <dir>", "Exact directory containing project-summary.json (overrides --output)")
  .option("--args <json>", "Arguments as one JSON object (merged before the key=value pairs)")
  .option("--analyze", "Allow the call to run an analysis when there is none or it is stale (default: read-only)", false)
  .option("--list", "List the tools and their arguments", false)
  .action(async (tool: string | undefined, pairs: string[], options) => {
    const { askTool, listTools, parseAskArgs } = await import("./mcp/ask.js");
    const { locateProjectRoot } = await import("./mcp/server.js");
    const root = options.project ? resolve(options.project) : locateProjectRoot(process.cwd()).root;
    const config = {
      projectRoot: root,
      analysisDir: options.analysisDir,
      outputBase: options.output,
      allowAnalyze: options.analyze === true,
      allowColdStart: options.analyze === true,
      version: program.version() ?? undefined,
    };
    if (options.list || !tool) {
      for (const t of listTools(config)) {
        console.log(`${t.name.replace(/^clarifydoc_/, "").padEnd(14)} ${t.args.join(" ")}`);
        console.log(`${"".padEnd(14)} ${t.description.split(/(?<=\.)\s/)[0]}`);
      }
      return;
    }
    try {
      const args = parseAskArgs(options.args, pairs);
      // stdout carries only the answer; an analysis this call runs logs to stderr.
      const out = process.stdout.write.bind(process.stdout);
      console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
      const r = await askTool(config, tool, args);
      out(r.text.endsWith("\n") ? r.text : r.text + "\n");
      if (r.isError) process.exitCode = 1;
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exitCode = 1;
    }
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
  .option("--max-files <n>", "Maximum number of files to analyze", wholeNumber(1))
  .option("--include <globs...>", "Additional file patterns to include")
  .option("--exclude <globs...>", "Additional file patterns to exclude")
  .option("--print-config <client>", "Print the MCP entry for a client and exit, without serving: claude-code | cursor | vscode | windsurf | gemini | codex | claude-desktop | zed | opencode | cline | all")
  .option("--tools <profile>", "Tools to offer: all, core (status, search, explain, trace, file, extract, impact, analyze), or names comma-separated", "all")
  .action(async (path: string, options) => {
    if (options.printConfig) {
      const { CLIENTS, mcpSnippet } = await import("./agents/install.js");
      const { locateProjectRoot: locate } = await import("./mcp/server.js");
      const root = path ? resolve(path) : locate(process.cwd()).root;
      const wanted = options.printConfig === "all" ? [...CLIENTS] : [options.printConfig];
      const unknown = wanted.filter((c) => !(CLIENTS as readonly string[]).includes(c));
      if (unknown.length) {
        console.error(`Unknown client: ${unknown.join(", ")}. Known: ${CLIENTS.join(", ")}, all.`);
        process.exitCode = 1;
        return;
      }
      for (const c of wanted) {
        const { file, snippet } = mcpSnippet(c as (typeof CLIENTS)[number], root);
        console.log(`# ${c} — add to ${file} (or: clarifydoc install --client ${c})\n${snippet}`);
      }
      return;
    }
    // Nothing may write to stdout from here on — it is the JSON-RPC wire.
    const { startMcpServer, locateProjectRoot } = await import("./mcp/server.js");
    // With no path given, serve the project the working directory sits in, so
    // an argument-free client config works from anywhere inside it. With no
    // project around it either, serve the directory but never scan it unasked.
    const located = path ? { root: resolve(path), marked: true } : locateProjectRoot(process.cwd());
    try {
      await startMcpServer({
        projectRoot: located.root,
        coldStartRefusal: located.marked
          ? undefined
          : `${located.root} is not inside a project (no .git, package.json or other project marker above it)`,
        analysisDir: options.analysisDir,
        outputBase: options.output,
        allowAnalyze: options.autoAnalyze !== false,
        allowColdStart: options.coldStart !== false,
        version: program.version() ?? undefined,
        tools: options.tools,
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

/** An analysis by its directory (holding project-summary.json) or by its project root (`<root>/<output>/<name>`). */
async function loadAnalysisAt(arg: string, output = ".clarifydoc") {
  const { existsSync } = await import("fs");
  const { join } = await import("path");
  const { loadReportSummary } = await import("./core/report-payload.js");
  const dir = resolve(arg);
  const candidates = [dir, join(dir, output, dir.replace(/\\/g, "/").split("/").pop()!)];
  const found = candidates.find((d) => existsSync(join(d, "project-summary.json")));
  if (!found) throw new Error(`No analysis at ${arg} (looked for project-summary.json in ${candidates.join(" and ")})`);
  return loadReportSummary(found);
}
