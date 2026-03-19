import type {
  FileAnalysis,
  SubComponentInfo,
  ExportInfo,
  PropertyInfo,
  ClassInfo,
  InteractiveElementInfo,
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
 */
export function parseDfm(source: string, filePath: string): FileAnalysis {
  const analysis = createEmptyAnalysis(filePath, "dfm");
  const lines = source.split(/\r?\n/);

  interface DfmObject {
    name: string;
    type: string;
    line: number;
    props: string[];
    events: { event: string; handler: string; line: number }[];
    dataLinks: { prop: string; target: string; line: number }[];
  }

  const objectStack: DfmObject[] = [];
  const allObjects: DfmObject[] = [];
  let rootObject: DfmObject | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();

    // Match "object Name: TType" or "inherited Name: TType" or "inline Name: TType"
    const objectMatch = trimmed.match(
      /^(?:object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/,
    );
    if (objectMatch) {
      const obj: DfmObject = {
        name: objectMatch[1],
        type: objectMatch[2],
        line: lineNum,
        props: [],
        events: [],
        dataLinks: [],
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
      objectStack.pop();
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

  return analysis;
}
