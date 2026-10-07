import type { Node, Tree } from "web-tree-sitter";
import type { InteractiveElementInfo, ScreenComponentCategory, ScreenComponentInfo, ScreenInfo } from "../../../types/analysis.js";
import { assignment, callArgs, callName, leafOf, stringValue } from "./syntax.js";

/** Page builders: the root of a Shiny UI (shiny, bslib, shinydashboard). */
const PAGES = /^(?:fluidPage|fixedPage|fillPage|bootstrapPage|navbarPage|dashboardPage|page_sidebar|page_navbar|page_fillable|page_fluid|page_fixed|page)$/;
const ACTIONS = new Set(["actionButton", "actionLink", "downloadButton", "downloadLink", "submitButton", "input_task_button"]);
const INPUTS = /^(?:textInput|textAreaInput|passwordInput|numericInput|selectInput|selectizeInput|checkboxInput|checkboxGroupInput|radioButtons|dateInput|dateRangeInput|sliderInput|fileInput|varSelectInput|input_switch)$/;
const OUTPUTS = /^(?:\w+Output|DTOutput)$/;
const CONTAINERS = /^(?:sidebarLayout|sidebarPanel|mainPanel|tabsetPanel|tabPanel|navbarMenu|navset_\w+|nav_panel|fluidRow|fixedRow|column|wellPanel|conditionalPanel|box|card|card_body|layout_sidebar|layout_columns|sidebar|dashboardHeader|dashboardSidebar|dashboardBody|tabItems|tabItem|div|tags\.div)$/;
/** Shiny's own functions in an observer — never the handler a click reaches. */
const SHINY_INTERNAL = /^(?:req|isolate|validate|need|showNotification|removeNotification|showModal|removeModal|modalDialog|update\w+|render\w+|reactive\w*|invalidateLater|freezeReactiveValue|print|message|cat|paste0?|c|list|return)$/;

function categoryOf(fn: string): ScreenComponentCategory | null {
  if (ACTIONS.has(fn)) return "action";
  if (INPUTS.test(fn)) return "input";
  if (OUTPUTS.test(fn)) return /table|DT|reactable/i.test(fn) ? "data" : "display";
  if (CONTAINERS.test(fn)) return "container";
  return null;
}

/** The UI widgets among a call's arguments (containers keep their own children). */
function components(call: Node): ScreenComponentInfo[] {
  const out: ScreenComponentInfo[] = [];
  for (const arg of callArgs(call)) {
    const target = arg.value;
    if (!target || target.type !== "call") continue;
    const fn = leafOf(callName(target) ?? "");
    const category = categoryOf(fn);
    const args = callArgs(target);
    const children = components(target);
    if (!category) {
      out.push(...children);
      continue;
    }
    const id = stringValue(args.find((a) => a.name === "inputId" || a.name === "outputId")?.value ?? args[0]?.value);
    const label = stringValue(args.find((a) => a.name === "label" || a.name === "title")?.value ?? args[1]?.value);
    out.push({
      name: category === "container" ? fn : id ?? fn,
      componentType: fn,
      category,
      caption: category === "container" ? stringValue(args[0]?.value) : label,
      position: null,
      align: null,
      visible: true,
      children: category === "container" ? children : [],
      events: category === "action" ? ["click"] : category === "input" ? ["change"] : [],
      dataBindings: id && category !== "container" ? [`${category === "input" || category === "action" ? "input" : "output"}$${id}`] : [],
      line: target.startPosition.row + 1,
    });
  }
  return out;
}

/** `ui <- fluidPage(titlePanel("Orders"), …)` (or a `ui.R` whose last expression is the page). */
export function extractShinyScreens(tree: Tree, sourceText: string, filePath: string): ScreenInfo[] {
  if (!/\b(?:fluidPage|fixedPage|fillPage|bootstrapPage|navbarPage|dashboardPage|page_\w+)\s*\(/.test(sourceText)) return [];
  const screens: ScreenInfo[] = [];
  for (const node of tree.rootNode.namedChildren) {
    const bound = assignment(node);
    const page = bound?.value.type === "call" ? bound.value : node.type === "call" ? node : null;
    if (!page || !PAGES.test(leafOf(callName(page) ?? ""))) continue;
    const title = page.descendantsOfType("call").find((c) => /^(?:titlePanel|dashboardHeader)$/.test(leafOf(callName(c) ?? "")));
    const caption = stringValue(callArgs(title ?? page)[0]?.value) ?? stringValue(callArgs(page).find((a) => a.name === "title")?.value);
    screens.push({
      name: bound?.name ?? filePath.replace(/^.*\//, "").replace(/\.[^.]+$/, ""),
      formType: "shiny",
      caption,
      dimensions: null,
      components: components(page),
      filePath,
      routePath: null,
      navigatesTo: [],
    });
  }
  return screens;
}

/**
 * What the server does when an input fires: `observeEvent(input$save, {
 * save_order(input$customer) })` — the button `save` (an `actionButton`
 * declared in the same file reads as a button; otherwise its kind is unknown)
 * reaches `save_order`, the first project function the observer calls.
 */
export function extractShinyInteractions(tree: Tree, sourceText: string): InteractiveElementInfo[] {
  if (!/\b(?:observeEvent|eventReactive|bindEvent)\s*\(/.test(sourceText)) return [];
  const kinds = new Map<string, string>();
  for (const call of tree.rootNode.descendantsOfType("call")) {
    const fn = leafOf(callName(call) ?? "");
    const id = stringValue(callArgs(call)[0]?.value);
    if (id && (ACTIONS.has(fn) || INPUTS.test(fn))) kinds.set(id, fn);
  }
  const out: InteractiveElementInfo[] = [];
  for (const call of tree.rootNode.descendantsOfType("call")) {
    const fn = leafOf(callName(call) ?? "");
    if (!/^(?:observeEvent|eventReactive|bindEvent)$/.test(fn)) continue;
    const args = callArgs(call);
    const trigger = args[0]?.value?.text.match(/^input\$(\w+)$/)?.[1];
    if (!trigger) continue;
    const body = fn === "bindEvent" ? args[0]?.value : args.find((a, i) => i > 0 && a.name !== "ignoreInit" && a.name !== "ignoreNULL")?.value;
    const handler = body
      ? [body, ...body.descendantsOfType("call")].map((c) => (c.type === "call" ? callName(c) : null)).find((n) => n && !SHINY_INTERNAL.test(leafOf(n))) ?? null
      : null;
    const kind = kinds.get(trigger);
    out.push({
      element: kind ? (ACTIONS.has(kind) ? "button" : /select|radio|checkbox/i.test(kind) ? "select" : "input") : "custom",
      event: kind && !ACTIONS.has(kind) ? "change" : "click",
      handler,
      line: call.startPosition.row + 1,
    });
  }
  return out;
}
