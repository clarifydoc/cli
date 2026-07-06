// Assembles the client-side JS bundle from ordered fragments.
// ORDER IS LOAD-BEARING: the bundle is one shared <script> scope with
// interleaved immediate calls and non-hoisted top-level consts. Do NOT
// reorder; report-tabs (trailing URL-hash nav) must stay last.
import { runtimeJs } from "./runtime.js";
import { filtersJs } from "./filters.js";
import { screensJs } from "./screens.js";
import { uiJs } from "./ui.js";
import { routesSummaryJs } from "./routes-summary.js";
import { tracesJs } from "./traces.js";
import { archC4Js } from "./arch-c4.js";
import { archGraphJs } from "./arch-graph.js";
import { archTypesJs } from "./arch-types.js";
import { archDataAccessJs } from "./arch-data-access.js";
import { dataModelJs } from "./data-model.js";
import { healthBlastJs } from "./health-blast.js";
import { reportTabsJs } from "./report-tabs.js";

const FRAGMENTS = [
  runtimeJs,
  filtersJs,
  screensJs,
  uiJs,
  routesSummaryJs,
  tracesJs,
  archC4Js,
  archGraphJs,
  archTypesJs,
  archDataAccessJs,
  dataModelJs,
  healthBlastJs,
  reportTabsJs,
];

export function renderClientJs(): string {
  // Leading/trailing \n reproduce the original `return \`\n...\n\`` exactly.
  return "\n" + FRAGMENTS.join("\n") + "\n";
}
