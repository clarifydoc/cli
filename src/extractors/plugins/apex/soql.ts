import type { ClassInfo, DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";
import { splitTopLevel } from "../../shared/split-top-level.js";
import { statementAccesses } from "../shared/sql-string-sources.js";
import { balancedArgs, blankStringAwareComments, lineIndex, lineStarts, matchingParen, splitTopLevelCommas } from "../shared/text-scan.js";
import { innermost, queryOpensAt, TRIGGER_HEAD } from "./patterns.js";
import { queryEnd, stringEnd } from "./source.js";

/**
 * Apex data access, read from the DATA text (comments blanked, strings and inline queries intact — `source.ts`):
 *
 *  - inline SOQL `[SELECT Id FROM Club__c WHERE …]` and SOSL `[FIND 'x' RETURNING Club__c(Id)]`: a read of each object
 *    the top-level query names. A relationship subquery `(SELECT Id FROM Players__r)` names a RELATIONSHIP, not an
 *    object: it is a row with `viaRelationship` and no entity, which the entity extractor's `reconcileProject`
 *    resolves through the lookup field declaring that relationship name (or drops);
 *  - a string literal that is a whole query (`'SELECT Id FROM Club__c'`, the pieces of `'SELECT Id ' + 'FROM Club__c'`
 *    joined): what `Database.query(…)`, `getQueryLocator(…)` and `countQuery(…)` run, found wherever the string sits;
 *  - DML — `insert x;`, `update`, `upsert`, `delete`, `undelete`, `merge`, `insert as user x;` and `Database.insert(x)` —
 *    a write of the SObject type the operand DECLARES: `new Club__c()`, a `List<Club__c>`/`Club__c[]`/`Set` variable
 *    (a local, a parameter, a field), `map.values()`, a query. An operand whose type is no SObject (a list of ids) or
 *    unknown (a call's result) is no row — a name is never read as a type;
 *  - `trigger X on Club__c (before insert)`: the trigger's object, with no access (it reacts to writes);
 *  - `HttpRequest` callouts: `req.setEndpoint('callout:League/clubs/' + id)` + `req.setMethod('GET')` on the same
 *    variable in one method → an api-call. A Named Credential is the call's external base (`baseRef`), never resolved here.
 */

/** Standard objects (API names) a project may touch without declaring; the rest of a name's evidence is its suffix. */
const STANDARD_OBJECTS: ReadonlySet<string> = new Set([
  "account", "contact", "lead", "opportunity", "opportunitylineitem", "case", "task", "event", "campaign", "campaignmember",
  "user", "group", "contract", "order", "orderitem", "asset", "product2", "pricebook2", "pricebookentry", "quote", "quotelineitem",
  "note", "attachment", "contentversion", "contentdocument", "document", "folder", "solution", "idea", "recordtype", "profile",
  "permissionset", "userrole", "organization", "emailmessage", "contactpointemail", "accountcontactrelation", "opportunitycontactrole",
  "permissionsetassignment", "objectpermissions", "fieldpermissions", "setupentityaccess", "contentdocumentlink", "contentdistribution", "feeditem", "feedcomment", "contentnote", "apexclass", "emailmessagerelation", "caseteammember", "casecomment", "entitlement", "servicecontract", "workorder", "workorderlineitem", "individual", "location",
]);

const CUSTOM_SUFFIX = /__(?:c|mdt|e|b|x|share|history|feed|ka|kav)$/i;

/** Whether a type name is an SObject: a custom/metadata/event suffix, or a standard object the platform ships. */
export function isSObjectType(name: string): boolean {
  return CUSTOM_SUFFIX.test(name) || STANDARD_OBJECTS.has(name.toLowerCase());
}

/** `List<Club__c>`, `Club__c[]`, `Map<Id, Club__c>`, `Schema.Account` → the SObject name the value holds; null when none is readable. */
export function elementType(type: string): string | null {
  const t = type.replace(/\s+/g, "");
  const list = /^(?:List|Set|Iterable|Iterator|Database\.QueryLocator)<(.+)>$/i.exec(t);
  const map = /^Map<[^,<>]+,(.+)>$/i.exec(t);
  const array = /^(.+)\[\]$/.exec(t);
  const inner = list?.[1] ?? map?.[1] ?? array?.[1] ?? t;
  const name = inner.replace(/^Schema\./i, "");
  return /^[A-Za-z_]\w*$/.test(name) ? name : null;
}

/** Text with the inside of every string literal blanked (quotes and newlines kept). */
const blankStrings = (text: string): string => blankStringAwareComments(text, { quotes: "'", strings: "blank", stringsEndAtLine: true, lineComments: [] });

/** Depth-0 view of a query: parenthesised parts and string contents blanked, so only its own clauses remain. */
function topLevel(query: string): string {
  let depth = 0;
  let out = "";
  for (const c of blankStrings(query)) {
    if (c === "(") { depth++; out += c; }
    else if (c === ")") { depth = Math.max(0, depth - 1); out += c; }
    else out += depth > 0 && c !== "\n" ? " " : c;
  }
  return out;
}

/**
 * The objects a SOQL query reads (its own `FROM`, then the objects its semi-joins read) or a SOSL search returns. A
 * relationship subquery (`FROM Players__r`) names a relationship, which is no SObject type: it is left out.
 */
export function queryObjects(query: string): string[] {
  const text = query.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (/^\s*FIND\b/i.test(text)) {
    // SOSL is no SQL: the objects follow `RETURNING`, each with its field list.
    const returning = /\bRETURNING\b([\s\S]*)$/i.exec(topLevel(text))?.[1];
    if (!returning) return [];
    return splitTopLevelCommas(returning).map((part) => /^\s*([A-Za-z_]\w*)/.exec(part)?.[1]).filter((n): n is string => !!n);
  }
  const found: string[] = [];
  for (const hit of statementAccesses(text)) {
    if (hit.routine) continue;
    const name = hit.table.split(".").pop()!;
    if ((!hit.joined || isSObjectType(name)) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The child relationships a SOQL query's select list names: `[SELECT Id, (SELECT Id FROM Players__r) FROM Club__c]` →
 * `{ parent: "Club__c", name: "Players__r" }`. Only subqueries before the query's own `FROM` count (one in a `WHERE`
 * is a semi-join over an object, read by `queryObjects`); a nested subquery is not followed.
 */
export function childRelationships(query: string): Array<{ parent: string; name: string }> {
  const text = query.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (/^\s*FIND\b/i.test(text)) return [];
  const flat = topLevel(text);
  const from = /\bFROM\s+([A-Za-z_][\w.]*)/i.exec(flat);
  if (!from) return [];
  const parent = from[1]!.split(".").pop()!;
  const blanked = blankStrings(text);
  const out: Array<{ parent: string; name: string }> = [];
  for (let i = 0; i < from.index; i++) {
    if (blanked[i] !== "(" || !/^\(\s*SELECT\b/i.test(blanked.slice(i, i + 16))) continue;
    const close = matchingParen(blanked, i);
    if (close < 0) break;
    const name = /\bFROM\s+([A-Za-z_]\w*)/i.exec(topLevel(blanked.slice(i + 1, close)))?.[1];
    if (name && !out.some((r) => r.name.toLowerCase() === name.toLowerCase())) out.push({ parent, name });
    i = close;
  }
  return out;
}

const relationshipRow = (name: string, rel: { parent: string; name: string }, line: number): DataSourceInfo => ({
  kind: "database", name, target: null, access: "read", viaRelationship: rel, calls: [], line,
});

interface Literal { start: number; end: number; value: string }

/** Whether the text is a whole SOQL statement a string holds. */
const SOQL_STRING = /^\s*SELECT\b[\s\S]*?\bFROM\s+[A-Za-z_]/i;

const DML_VERBS = "insert|update|upsert|delete|undelete|merge";
const DML = new RegExp(String.raw`(?<=^|[;{}\)]|\belse\b)[ \t\r\n]*\b(${DML_VERBS})\b[ \t\r\n]*(?:as[ \t]+(?:user|system)\b[ \t\r\n]*)?([^;]*);`, "gim");
const DATABASE_DML = /\bDatabase\.(insert|update|upsert|delete|undelete|merge|insertImmediate|deleteImmediate|insertAsync|updateAsync|upsertAsync|deleteAsync)\s*\(/gi;
const TRIGGER = new RegExp(TRIGGER_HEAD.source, "im");

/**
 * The declared type of variable `name` at `line`: a local or parameter of the method that holds the line (Apex names
 * are case-insensitive), then a field of the class that declares the method and of the classes around it.
 */
function declaredType(name: string, line: number, classes: readonly ClassInfo[], methods: readonly FunctionInfo[]): string | null {
  const key = name.toLowerCase();
  const owner = innermost(methods, line);
  const local = owner?.localTypes?.find((l) => l.name.toLowerCase() === key) ?? owner?.params.find((p) => p.name.toLowerCase() === key);
  if (local?.type) return local.type;
  const around = classes.filter((c) => c.line <= line && line <= c.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line));
  for (const cls of around) {
    const field = cls.properties.find((p) => p.name.toLowerCase() === key);
    if (field?.type) return field.type;
  }
  return null;
}

/** The SObject type a DML operand holds, from its text; null when the text states none. */
function operandObject(operand: string, line: number, classes: readonly ClassInfo[], methods: readonly FunctionInfo[]): string | null {
  const text = operand.trim();
  if (text === "") return null;
  let type: string | null = null;
  if (text.startsWith("[")) {
    type = queryObjects(text)[0] ?? null;
  } else {
    const fresh = /^new\s+([\w.]+(?:\s*<[^;(){}]*>)?(?:\s*\[\s*\])?)/i.exec(text)?.[1];
    const values = /^([A-Za-z_]\w*)\s*\.\s*values\s*\(\s*\)\s*$/i.exec(text)?.[1];
    const bare = /^([A-Za-z_]\w*)(?=\s|$)(?!\s*[.(])/.exec(text)?.[1];
    if (fresh) type = elementType(fresh);
    else if (values ?? bare) {
      const declared = declaredType((values ?? bare)!, line, classes, methods);
      type = declared ? elementType(declared) : null;
    }
  }
  return type && isSObjectType(type) ? type : null;
}

const row = (name: string, entity: string, access: "read" | "write" | undefined, line: number): DataSourceInfo => ({
  kind: "database", name, target: entity, entity, ...(access ? { access } : {}), calls: [], line,
});

/** The string literals of the text outside inline queries, pieces joined by `+`. */
function literalsOf(text: string): Literal[] {
  const found: Literal[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'") {
      const end = stringEnd(text, i);
      found.push({ start: i, end, value: text.slice(i + 1, end - 1) });
      i = end;
    } else if (c === "[" && queryOpensAt(text, i)) i = queryEnd(text, i);
    else i++;
  }
  const merged: Literal[] = [];
  for (const lit of found) {
    const last = merged[merged.length - 1];
    // `'SELECT ' + fields + ' FROM Club__c'`: a name between the pieces is a hole, not the end of the statement.
    const gap = last ? text.slice(last.end, lit.start) : "";
    if (last && /^\s*\+\s*(?:[A-Za-z_][\w.]*(?:\([^()']*\))?\s*\+\s*)?$/.test(gap)) { last.end = lit.end; last.value += (/[\w.]/.test(gap) ? " ? " : "") + lit.value; }
    else merged.push({ ...lit });
  }
  return merged;
}

/** `'callout:League/clubs/' + id` → `callout:League/clubs/{id}`; null when the expression does not start with a literal. */
function endpointOf(expr: string): string | null {
  const parts = splitTopLevel(expr, { sep: "+", quotes: "'", escapes: "'", brackets: "", trim: true, dropBlank: true });
  if (parts.length === 0 || !/^'/.test(parts[0]!)) return null;
  let out = "";
  for (const part of parts) {
    const lit = /^'((?:[^'\\]|\\.)*)'$/.exec(part);
    if (lit) out += lit[1]!.replace(/\\'/g, "'");
    else {
      const name = /([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*$/.exec(part)?.[1];
      out += name ? `{${name}}` : "{}";
    }
  }
  return out;
}

/** Every data access the file's text states (see the file header). */
export function apexDataSources(dataText: string, classes: readonly ClassInfo[], functions: readonly FunctionInfo[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const lineOf = lineIndex(dataText);
  // Methods and free functions (a trigger) scope their variables alike.
  const methods = [...new Set([...classes.flatMap((c) => c.methods), ...functions])];

  // Inline queries.
  for (let i = 0; i < dataText.length; i++) {
    const c = dataText[i]!;
    if (c === "'") i = stringEnd(dataText, i) - 1;
    else if (c === "[" && queryOpensAt(dataText, i)) {
      const end = queryEnd(dataText, i);
      const verb = queryOpensAt(dataText, i)!;
      const query = dataText.slice(i, end);
      for (const object of queryObjects(query)) out.push(row(verb, object, "read", lineOf(i)));
      for (const rel of childRelationships(query)) out.push(relationshipRow(verb, rel, lineOf(i)));
      i = end - 1;
    }
  }

  // A query held in a string: `Database.query('SELECT …')`, `String q = 'SELECT …'`.
  for (const lit of literalsOf(dataText)) {
    if (!SOQL_STRING.test(lit.value)) continue;
    for (const object of queryObjects(lit.value)) out.push(row("SELECT", object, "read", lineOf(lit.start)));
    for (const rel of childRelationships(lit.value)) out.push(relationshipRow("SELECT", rel, lineOf(lit.start)));
  }

  // DML statements and `Database.*` calls.
  const code = blankStrings(dataText);
  for (const m of code.matchAll(DML)) {
    const verb = m[1]!.toUpperCase();
    const operand = m[2]!;
    if (/^\s*[(=.]/.test(operand)) continue;
    const at = m.index! + m[0].search(new RegExp(String.raw`\b${m[1]!}\b`, "i"));
    const line = lineOf(at);
    const type = operandObject(operand, line, classes, methods);
    if (type) out.push(row(verb, type, "write", line));
  }
  for (const m of code.matchAll(DATABASE_DML)) {
    const open = m.index! + m[0].length - 1;
    const args = balancedArgs(code, open);
    if (!args) continue;
    const line = lineOf(m.index!);
    const type = operandObject(splitTopLevelCommas(args.args)[0] ?? "", line, classes, methods);
    if (type) out.push(row(`Database.${m[1]!.toLowerCase()}`, type, "write", line));
  }

  // The object a trigger is declared on.
  const trigger = TRIGGER.exec(code);
  if (trigger) {
    const line = lineOf(trigger.index + trigger[0].indexOf("trigger"));
    out.push(row(`TRIGGER ${trigger[3]!.replace(/\s+/g, " ").trim()}`, trigger[2]!, undefined, line));
  }

  out.push(...callouts(dataText, lineOf, methods));
  return out;
}

/** `req.setEndpoint(…)` calls with the verb `req.setMethod('…')` states in the same method. */
function callouts(text: string, lineOf: (offset: number) => number, methods: readonly FunctionInfo[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const starts = lineStarts(text);
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*setEndpoint\s*\(/gi)) {
    const open = m.index! + m[0].length - 1;
    const args = balancedArgs(text, open);
    if (!args) continue;
    const endpoint = endpointOf(args.args);
    if (endpoint === null) continue;
    const at = lineOf(m.index!);
    const owner = innermost(methods, at);
    const scope = owner ? text.slice(starts[owner.line - 1], starts[owner.endLine] ?? text.length) : text;
    const verb = new RegExp(String.raw`\b${m[1]!}\s*\.\s*setMethod\s*\(\s*'(\w+)'`, "i").exec(scope)?.[1]?.toUpperCase();
    // A credential named by a variable (`'callout:' + name + path`) is unknown: the endpoint stays as written.
    const named = /^callout:([\w.-]+)(?=[/?]|$)(.*)$/i.exec(endpoint);
    const target = named ? (named[2] || "/") : endpoint;
    out.push({
      kind: "api-call",
      name: verb ? `${verb} ${target}` : target,
      ...(verb ? { httpMethod: verb } : {}),
      target,
      ...(named ? { baseRef: { kind: "client" as const, key: `callout:${named[1]!}` } } : {}),
      calls: [],
      line: at,
      column: m.index! - starts[at - 1]!,
    });
  }
  return out;
}
