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
import { binaryDfmToText, isBinaryDfm } from "./dfm-binary.js";
import { asDoubleQuotedLiteral, extractSqlStringDataSources } from "../extractors/plugins/shared/sql-string-sources.js";
import { extractDfmEntities } from "../extractors/plugins/pascal/dfm-entities.js";

/** Map Delphi VCL/FMX component types to interactive element categories */
const DFM_ELEMENT_MAP: Record<string, InteractiveElementInfo["element"]> = {
  tbutton: "button",
  tbitbtn: "button",
  tspeedbutton: "button",
  tcornerbutton: "button",
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
  // FMX containers
  tlayout: "container", tgridpanellayout: "container", tflowlayout: "container",
  tscaledlayout: "container", ttabcontrol: "container", ttabitem: "container",
  texpander: "container", trectangle: "container",
  // Inputs
  tedit: "input", tlabelededit: "input", tmaskedit: "input",
  tmemo: "input", trichedit: "input", tcombobox: "input",
  tcomboboxex: "input", tcheckbox: "input", tradiobutton: "input",
  tradiogroup: "input", tdatetimepicker: "input", tspinedit: "input",
  tnumberbox: "input", tcolorbox: "input",
  tswitch: "input", ttrackbar: "input", tspinbox: "input", tarcdial: "input",
  // Display
  tlabel: "display", timage: "display", tstatusbar: "display",
  tprogressbar: "display", tshape: "display", tbevel: "display",
  ttext: "display", timagecontrol: "display", tpath: "display",
  tcircle: "display", tline: "display",
  // Data
  tdbgrid: "data", tdbnavigator: "data", tdbedit: "data",
  tdbmemo: "data", tdbcombobox: "data", tdbcheckbox: "data",
  tdbimage: "data", tdblookupcombobox: "data", tstringgrid: "data",
  tdatasource: "data", tclientdataset: "data", tfdmemtable: "data",
  tquery: "data", ttable: "data",
  tfdconnection: "data", tfdquery: "data", tfdtable: "data",
  tbindsourcedb: "data", tbindnavigator: "data", tbindingslist: "data",
  // Action
  tbutton: "action", tbitbtn: "action", tspeedbutton: "action",
  ttoolbar: "action", ttoolbutton: "action", tcornerbutton: "action",
  // Navigation
  tmainmenu: "navigation", tpopupmenu: "navigation", tmenuitem: "navigation",
  ttreeview: "navigation", tlistview: "navigation", tlistbox: "navigation",
  ttreeviewitem: "navigation", tlistboxitem: "navigation",
};

/** Visual properties we capture values for (case-insensitive match) */
const VISUAL_PROPS = new Set([
  "Caption", "Text", "TextHint", "Width", "Height", "Left", "Top",
  "ClientWidth", "ClientHeight", "Align", "Visible", "Enabled", "FieldName",
  // Declared width of a persistent TStringField — the column's varchar length.
  "Size",
]);

/** String-list properties that hold SQL on data components (TQuery.SQL,
 *  TIBDataSet.SelectSQL, TADODataSet.CommandText as list, …). */
// `UpdateSQL` is FIBPlus/IBX naming for what IBX also calls `ModifySQL` — the
// dataset's UPDATE statement. It is the single most reliable table-identity
// signal on a Delphi dataset, so missing it hid both the UPDATE data access and
// the table's writable column list.
const DB_LIST_PROP_RE = /^(SQL|SelectSQL|ModifySQL|UpdateSQL|InsertSQL|DeleteSQL|RefreshSQL|CommandText)\.Strings$/;

/** Scalar properties that name the table / statement directly. */
const DB_SCALAR_PROPS = new Set(["TableName", "CommandText"]);

/** `CUSTOMER.DB` / `orders.dbf` (BDE Paradox/dBase) → bare table name. */
function tableNameFromFile(value: string): string {
  return value.replace(/\.(db|dbf)$/i, "");
}

/** Database sources declared in the FORM: `TableName = 'customers'` or SQL
 *  text living in SQL.Strings/CommandText. The SQL is pushed through the
 *  shared SQL-string scanner so verb/table parsing (and its vetoes) match
 *  every other language. */
function dbSourcesFromObject(
  obj: { name: string; dbProps: { prop: string; value: string; line: number }[] },
): FileAnalysis["dataSources"] {
  const out: FileAnalysis["dataSources"] = [];
  for (const { prop, value, line } of obj.dbProps) {
    if (prop === "TableName") {
      const table = tableNameFromFile(value);
      if (!/^[A-Za-z_][\w .-]*$/.test(table)) continue;
      out.push({
        kind: "database",
        name: `${obj.name}.TableName`,
        target: table,
        entity: table,
        calls: [],
        line,
      });
      continue;
    }
    // SQL text (SQL.Strings list or CommandText scalar/list).
    const asLine = asDoubleQuotedLiteral(value);
    for (const src of extractSqlStringDataSources([asLine])) {
      out.push({ ...src, name: `${obj.name}: ${src.name}`, line });
    }
  }
  return out;
}

/**
 * `component name → table` for data components whose query/table resolved.
 * Published as `stringConstants` so the project-wide constants pass
 * (`resolveDataSourceStringConstants`) rewrites the CODE side's
 * `qrySales.Open` (target/entity = the component name, from the companion
 * unit) to the physical table declared here in the form — one datastore node
 * instead of two, and the method attributes to the real entity.
 */
function componentTableConstants(
  objects: { name: string; dbProps: { prop: string; value: string; line: number }[] }[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const obj of objects) {
    if (obj.dbProps.length === 0 || !/^[A-Za-z_]\w*$/.test(obj.name)) continue;
    const table = dbSourcesFromObject(obj).find((s) => s.entity)?.entity;
    if (table && table !== obj.name) map[obj.name] = table;
  }
  return map;
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
 *   - Screen/form structure with hierarchy and visual properties (as ScreenInfo)
 */
export function parseDfm(source: string, filePath: string): FileAnalysis {
  const analysis = createEmptyAnalysis(filePath, "dfm");
  // Delphi ≤4 saved forms as binary TWriter streams — convert to the text
  // form first so both formats share one extraction path (needs the file
  // read as latin1; see `sourceEncoding` on the dfm meta).
  if (isBinaryDfm(source)) {
    const text = binaryDfmToText(source);
    if (text === null) return analysis;
    source = text;
  }
  const lines = source.split(/\r?\n/);

  interface DfmObject {
    name: string;
    type: string;
    line: number;
    props: string[];
    propValues: Map<string, string>;
    events: { event: string; handler: string; line: number }[];
    dataLinks: { prop: string; target: string; line: number }[];
    /** DB-shaped properties (TableName, SQL.Strings, …) with their lines. */
    dbProps: { prop: string; value: string; line: number }[];
    parentIndex: number | null;
  }

  const objectStack: DfmObject[] = [];
  const allObjects: DfmObject[] = [];
  let rootObject: DfmObject | null = null;
  let insideCollection = 0; // track depth of <...> collection blocks
  /** Open multi-line string list (`SQL.Strings = (` … `'…')`). */
  let pendingList: {
    obj: DfmObject;
    prop: string;
    line: number;
    parts: string[];
    /** Previous line ended in `+`, so this line CONTINUES the same string. */
    continues: boolean;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();

    // Continuation of a captured multi-line string list.
    if (pendingList) {
      // Delphi wraps a long SQL line as `'…FIRST HALF' +` / `'SECOND HALF'`.
      // The two fragments are ONE source line, split mid-token — joining them
      // with a space would corrupt the identifier straddling the break
      // (`GARAGE1.POST' + 'CODE` → `GARAGE1.POST CODE`). Only a line NOT continued by
      // `+` starts a new SQL line, which does get a separating space.
      let first = true;
      for (const m of trimmed.matchAll(/'((?:[^']|'')*)'/g)) {
        const text = m[1]!.replace(/''/g, "'");
        if (first && pendingList.continues && pendingList.parts.length > 0) {
          pendingList.parts[pendingList.parts.length - 1] += text;
        } else {
          pendingList.parts.push(text);
        }
        first = false;
      }
      pendingList.continues = /\+\s*$/.test(trimmed);
      if (/\)\s*$/.test(trimmed)) {
        pendingList.obj.dbProps.push({
          prop: pendingList.prop,
          value: pendingList.parts.join(" "),
          line: pendingList.line,
        });
        pendingList = null;
      }
      continue;
    }

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
        dbProps: [],
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

    const propMatch = trimmed.match(/^([\w.]+)\s*=\s*(.+)/);
    if (propMatch) {
      const propName = propMatch[1];
      const propValue = propMatch[2];

      // Query/table text on data components: TableName = 'customers',
      // SQL.Strings = (…) — single-line form (binary conversion) or the
      // multi-line text form, which opens a pendingList.
      if (DB_LIST_PROP_RE.test(propName)) {
        if (propValue === "(") {
          pendingList = { obj: current, prop: propName, line: lineNum, parts: [], continues: false };
        } else {
          const parts = [...propValue.matchAll(/'((?:[^']|'')*)'/g)].map(
            (m) => m[1]!.replace(/''/g, "'"),
          );
          if (parts.length > 0) {
            current.dbProps.push({ prop: propName, value: parts.join(" "), line: lineNum });
          }
        }
        continue;
      }
      if (DB_SCALAR_PROPS.has(propName)) {
        current.dbProps.push({ prop: propName, value: stripQuotes(propValue), line: lineNum });
      }

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
      } else if (!propName.includes(".")) {
        // Dotted props (Font.Name, …) are sub-property noise for the
        // component-shape consumers — keep props lists as before.
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
    // Table names / SQL statements on data components → database sources
    analysis.dataSources.push(...dbSourcesFromObject(obj));
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
    analysis.dataSources.push(...dbSourcesFromObject(rootObject));
  }

  // Component→table map for the project-wide constants pass (joins the
  // companion unit's `qrySales.Open` to the SQL declared on the form).
  const tableConstants = componentTableConstants(allObjects);
  if (Object.keys(tableConstants).length > 0) {
    analysis.stringConstants = tableConstants;
  }

  // Physical tables + their columns, reconstructed from the SQL and persistent
  // TField children the IDE persisted on this form's datasets. A Delphi repo
  // holds no DDL, so the .dfm is the only in-repo description of the schema.
  const { entities, relations } = extractDfmEntities(allObjects);
  if (entities.length > 0) analysis.classes.push(...entities);
  if (relations.length > 0) analysis.entityRelations = relations;

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
    routePath: null,
    navigatesTo: [],
  };
}
