import type {
  FileAnalysis,
  SubComponentInfo,
  ExportInfo,
  PropertyInfo,
  ClassInfo,
  InteractiveElementInfo,
  ScreenComponentCategory,
  ScreenComponentInfo,
  ScreenInfo,
} from "../types/analysis.js";
import { createEmptyAnalysis } from "../types/analysis.js";

/** Map Delphi VCL/FMX component types to interactive element categories */
const DFM_ELEMENT_MAP: Record<string, InteractiveElementInfo["element"]> = {
  tbutton: "button",
  tbitbtn: "button",
  tspeedbutton: "button",
  tedit: "input",
  tlabelededit: "input",
  tmaskedit: "input",
  tnumberbox: "input",
  tspinedit: "input",
  tcombobox: "select",
  tcomboboxex: "select",
  tcolorbox: "select",
  tmemo: "textarea",
  trichedit: "textarea",
};

function resolveDfmElementType(
  componentType: string,
  isRoot: boolean,
): InteractiveElementInfo["element"] {
  if (isRoot) return "form";
  return DFM_ELEMENT_MAP[componentType.toLowerCase()] ?? "custom";
}

/** Map Delphi VCL/FMX component types to screen component categories */
const DFM_CATEGORY_MAP: Record<string, ScreenComponentCategory> = {
  // Containers
  tpanel: "container", tgroupbox: "container", tpagecontrol: "container",
  ttabsheet: "container", tscrollbox: "container", tsplitter: "container",
  tflowpanel: "container", tgridpanel: "container", tframe: "container",
  // Inputs
  tedit: "input", tlabelededit: "input", tmaskedit: "input",
  tmemo: "input", trichedit: "input", tcombobox: "input",
  tcomboboxex: "input", tcheckbox: "input", tradiobutton: "input",
  tradiogroup: "input", tdatetimepicker: "input", tspinedit: "input",
  tnumberbox: "input", tcolorbox: "input",
  // Display
  tlabel: "display", timage: "display", tstatusbar: "display",
  tprogressbar: "display", tshape: "display", tbevel: "display",
  // Data
  tdbgrid: "data", tdbnavigator: "data", tdbedit: "data",
  tdbmemo: "data", tdbcombobox: "data", tdbcheckbox: "data",
  tdbimage: "data", tdblookupcombobox: "data", tstringgrid: "data",
  tdatasource: "data", tclientdataset: "data", tfdmemtable: "data",
  tquery: "data", ttable: "data",
  // Action
  tbutton: "action", tbitbtn: "action", tspeedbutton: "action",
  ttoolbar: "action", ttoolbutton: "action",
  // Navigation
  tmainmenu: "navigation", tpopupmenu: "navigation", tmenuitem: "navigation",
  ttreeview: "navigation", tlistview: "navigation", tlistbox: "navigation",
};

/** Visual properties we capture values for (case-insensitive match) */
const VISUAL_PROPS = new Set([
  "Caption", "Text", "TextHint", "Width", "Height", "Left", "Top",
  "ClientWidth", "ClientHeight", "Align", "Visible", "Enabled", "FieldName",
]);

/**
 * Parse a Delphi .dfm (form definition) file.
 *
 * DFM files describe a visual component tree in a custom text format:
 *   object frmMain: TfrmMain
 *     Left = 0
 *     ...
 *     object pnlTop: TPanel
 *       ...
 *     end
 *   end
 *
 * We extract:
 *   - The root form class (as a ClassInfo export)
 *   - All nested component objects (as SubComponentInfo)
 *   - Event handler wiring (OnClick = btnAddClick → captured as properties)
 *   - DataSource/DataSet linkages (as dataSources)
 *   - Screen/form structure with hierarchy and visual properties (as ScreenInfo)
 */
export function parseDfm(source: string, filePath: string): FileAnalysis {
  const analysis = createEmptyAnalysis(filePath, "dfm");
  const lines = source.split(/\r?\n/);

  interface DfmObject {
    name: string;
    type: string;
    line: number;
    props: string[];
    propValues: Map<string, string>;
    events: { event: string; handler: string; line: number }[];
    dataLinks: { prop: string; target: string; line: number }[];
    parentIndex: number | null;
  }

  const objectStack: DfmObject[] = [];
  const allObjects: DfmObject[] = [];
  let rootObject: DfmObject | null = null;
  let insideCollection = 0; // track depth of <...> collection blocks

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();

    // Track collection blocks (Columns = <...>) to avoid mismatching "end"
    if (trimmed.endsWith("= <") || trimmed.endsWith("= <>")) {
      if (!trimmed.endsWith("= <>")) insideCollection++;
      continue;
    }
    if (insideCollection > 0) {
      // "end>" or standalone ">" closes a collection
      if (trimmed === "end>" || trimmed === ">") {
        insideCollection--;
      }
      // "item" / "end" inside collections are not real objects
      continue;
    }

    // Match "object Name: TType" or "inherited Name: TType" or "inline Name: TType"
    const objectMatch = trimmed.match(
      /^(?:object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/,
    );
    if (objectMatch) {
      const parentIdx = objectStack.length > 0
        ? allObjects.indexOf(objectStack[objectStack.length - 1])
        : null;

      const obj: DfmObject = {
        name: objectMatch[1],
        type: objectMatch[2],
        line: lineNum,
        props: [],
        propValues: new Map(),
        events: [],
        dataLinks: [],
        parentIndex: parentIdx,
      };

      if (!rootObject) {
        rootObject = obj;
      }

      allObjects.push(obj);
      objectStack.push(obj);
      continue;
    }

    // Match "end" closing an object
    if (trimmed === "end") {
      if (objectStack.length > 0) objectStack.pop();
      continue;
    }

    // Match property assignments within current object
    const current = objectStack[objectStack.length - 1];
    if (!current) continue;

    const propMatch = trimmed.match(/^(\w+)\s*=\s*(.+)/);
    if (propMatch) {
      const propName = propMatch[1];
      const propValue = propMatch[2];

      // Event handlers: OnClick = btnAddClick
      if (propName.startsWith("On")) {
        current.events.push({
          event: propName,
          handler: propValue,
          line: lineNum,
        });
      }
      // Data linkage: DataSource = dsUsers, DataSet = cdsUsers, Server = DSServer
      else if (
        /^(DataSource|DataSet|SQLConnection|Server|Connection)$/.test(propName)
      ) {
        current.dataLinks.push({
          prop: propName,
          target: propValue,
          line: lineNum,
        });
      } else {
        current.props.push(propName);
      }

      // Capture visual property values regardless of category above
      if (VISUAL_PROPS.has(propName)) {
        current.propValues.set(propName, propValue);
      }
    }
  }

  // Export the root form object as a class
  if (rootObject) {
    const properties: PropertyInfo[] = rootObject.props.map((p) => ({
      name: p,
      type: null,
      visibility: "public" as const,
      isStatic: false,
      isReadonly: false,
    }));

    const cls: ClassInfo = {
      name: rootObject.type,
      extends: null,
      implements: [],
      decorators: [],
      methods: [],
      properties,
      isExported: true,
      line: rootObject.line,
      endLine: lines.length,
    };
    analysis.classes.push(cls);

    const exp: ExportInfo = {
      name: rootObject.name,
      kind: "variable",
      line: rootObject.line,
    };
    analysis.exports.push(exp);
  }

  // All child objects become subComponents
  for (const obj of allObjects) {
    if (obj === rootObject) continue;

    const comp: SubComponentInfo = {
      name: obj.name,
      importSource: obj.type,
      props: [
        ...obj.props,
        ...obj.events.map((e) => e.event),
      ],
      line: obj.line,
    };
    analysis.subComponents.push(comp);

    // Event handlers → we record them so the companion .pas knows what's wired
    for (const ev of obj.events) {
      analysis.dataMutations.push({
        kind: "assignment",
        target: `${obj.name}.${ev.event}`,
        value: ev.handler,
        line: ev.line,
      });
      analysis.interactiveElements.push({
        element: resolveDfmElementType(obj.type, false),
        event: ev.event,
        handler: ev.handler,
        line: ev.line,
      });
    }

    // Data linkages → dataSources
    for (const link of obj.dataLinks) {
      analysis.dataSources.push({
        kind: "database",
        calls: [],
        name: `${obj.name}.${link.prop}`,
        target: link.target,
        line: link.line,
      });
    }
  }

  // Root object event handlers too
  if (rootObject) {
    for (const ev of rootObject.events) {
      analysis.dataMutations.push({
        kind: "assignment",
        target: `${rootObject.name}.${ev.event}`,
        value: ev.handler,
        line: ev.line,
      });
      analysis.interactiveElements.push({
        element: resolveDfmElementType(rootObject.type, true),
        event: ev.event,
        handler: ev.handler,
        line: ev.line,
      });
    }
    for (const link of rootObject.dataLinks) {
      analysis.dataSources.push({
        kind: "database",
        calls: [],
        name: `${rootObject.name}.${link.prop}`,
        target: link.target,
        line: link.line,
      });
    }
  }

  // Build screen info with hierarchy
  if (rootObject) {
    analysis.screens.push(buildScreenInfo(rootObject, allObjects, filePath));
  }

  return analysis;
}

// ─── Screen tree builder ──────────────────────────────────────────────────

/** Strip Delphi string quotes: 'Hello' → Hello */
function stripQuotes(s: string): string {
  return s.replace(/^'(.*)'$/, "$1");
}

function buildScreenInfo(
  rootObject: { name: string; type: string; line: number; propValues: Map<string, string>; events: { event: string }[]; dataLinks: { prop: string; target: string }[]; parentIndex: number | null },
  allObjects: { name: string; type: string; line: number; propValues: Map<string, string>; events: { event: string }[]; dataLinks: { prop: string; target: string }[]; parentIndex: number | null }[],
  filePath: string,
): ScreenInfo {
  // Build children map: parentIndex → child objects
  const childrenMap = new Map<number, typeof allObjects>();
  for (let i = 0; i < allObjects.length; i++) {
    const obj = allObjects[i];
    if (obj.parentIndex !== null) {
      let siblings = childrenMap.get(obj.parentIndex);
      if (!siblings) {
        siblings = [];
        childrenMap.set(obj.parentIndex, siblings);
      }
      siblings.push(obj);
    }
  }

  function toScreenComponent(obj: typeof allObjects[0], objIndex: number): ScreenComponentInfo {
    const pv = obj.propValues;
    const left = parseInt(pv.get("Left") ?? "", 10);
    const top = parseInt(pv.get("Top") ?? "", 10);
    const width = parseInt(pv.get("Width") ?? "", 10);
    const height = parseInt(pv.get("Height") ?? "", 10);
    const hasPosition = !isNaN(left) && !isNaN(top) && !isNaN(width) && !isNaN(height);

    const rawCaption = pv.get("Caption") ?? pv.get("Text") ?? pv.get("TextHint") ?? null;
    const caption = rawCaption ? stripQuotes(rawCaption) : null;

    const children = (childrenMap.get(objIndex) ?? []).map((child) =>
      toScreenComponent(child, allObjects.indexOf(child)),
    );

    return {
      name: obj.name,
      componentType: obj.type,
      category: DFM_CATEGORY_MAP[obj.type.toLowerCase()] ?? "display",
      caption,
      position: hasPosition ? { left, top, width, height } : null,
      align: pv.get("Align") ?? null,
      visible: pv.get("Visible") !== "False",
      children,
      events: obj.events.map((e) => e.event),
      dataBindings: obj.dataLinks.map((d) => `${d.prop}=${d.target}`),
      line: obj.line,
    };
  }

  const rootIndex = allObjects.indexOf(rootObject);
  const rootPv = rootObject.propValues;
  const cw = parseInt(rootPv.get("ClientWidth") ?? rootPv.get("Width") ?? "", 10);
  const ch = parseInt(rootPv.get("ClientHeight") ?? rootPv.get("Height") ?? "", 10);

  const topLevelChildren = (childrenMap.get(rootIndex) ?? []).map((child) =>
    toScreenComponent(child, allObjects.indexOf(child)),
  );

  return {
    name: rootObject.name,
    formType: rootObject.type,
    caption: rootPv.has("Caption") ? stripQuotes(rootPv.get("Caption")!) : null,
    dimensions: !isNaN(cw) && !isNaN(ch) ? { width: cw, height: ch } : null,
    components: topLevelChildren,
    filePath,
  };
}
