/**
 * Vitest global setup: plugins load lazily in production (the analyzer
 * activates only the languages a project uses), but tests exercise extraction
 * paths for arbitrary languages directly — load everything up front so
 * `pluginFor()` never throws its "not loaded" guard in a test.
 */
import { loadAllPlugins } from "./extractors/registry.js";

await loadAllPlugins();
