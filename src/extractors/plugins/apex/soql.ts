import type { ClassInfo, DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";
import { balancedArgs, lineOfOffset, lineStarts, splitTopLevelCommas } from "../shared/text-scan.js";
import { queryEnd, stringEnd } from "./source.js";

/**
 * Apex data access, read from the DATA text (comments blanked, strings and inline queries intact — `source.ts`):
 *
 *  - inline SOQL `[SELECT Id FROM Club__c WHERE …]` and SOSL `[FIND 'x' RETURNING Club__c(Id)]`: a read of each object
 *    the top-level query names. A relationship subquery `(SELECT Id FROM Players__r)` names a RELATIONSHIP, not an
 *    object — it is left out (the parent query's own object is the access);
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
function blankStrings(text: string): string {
  const out = text.split("");
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "'") continue;
    const end = stringEnd(text, i);
    for (let k = i + 1; k < end - 1; k++) out[k] = " ";
    i = end - 1;
  }
  return out.join("");
}

/** Depth-0 view of a query: parenthesised parts and string contents blanked, so only its own clauses remain. */
function topLevel(query: string): string {
  const s = blankStrings(query);
  let depth = 0;
  let out = "";
  for (const c of s) {
    if (c === "(") { depth++; out += c; }
    else if (c === ")") { depth = Math.max(0, depth - 1); out += c; }
    else out += depth > 0 && c !== "\n" ? " " : c;
  }
  return out;
}

/** The objects a SOQL query reads (its own `FROM`) or a SOSL search returns. */
export function queryObjects(query: string): string[] {
  const q = topLevel(query.trim().replace(/^\[/, "").replace(/\]$/, ""));
  if (/^\s*FIND\b/i.test(q)) {
    const returning = /\bRETURNING\b([\s\S]*)$/i.exec(q)?.[1];
    if (!returning) return [];
    return splitTopLevelCommas(returning).map((part) => /^\s*([A-Za-z_]\w*)/.exec(part)?.[1]).filter((n): n is string => !!n);
  }
  const from = /\bFROM\s+([A-Za-z_][\w.]*)/i.exec(q)?.[1];
  const found = from ? [from.split(".").pop()!] : [];
  // A semi-join or anti-join in a WHERE clause (`Id IN (SELECT Club__c FROM Player__c)`) reads an object too; a
  // relationship subquery (`FROM Players__r`) names a relationship, which is no SObject type.
  for (const m of blankStrings(query).matchAll(/\(\s*SELECT\b[^()]*?\bFROM\s+([A-Za-z_]\w*)/gi)) {
    if (isSObjectType(m[1]!) && !found.includes(m[1]!)) found.push(m[1]!);
  }
  return found;
}

interface Literal { start: number; end: number; value: string }

/** Whether the text is a whole SOQL statement a string holds. */
const SOQL_STRING = /^\s*SELECT\b[\s\S]*?\bFROM\s+[A-Za-z_]/i;

const DML_VERBS = "insert|update|upsert|delete|undelete|merge";
const DML = new RegExp(String.raw`(?<=^|[;{}\)]|\belse\b)[ \t\r\n]*\b(${DML_VERBS})\b[ \t\r\n]*(?:as[ \t]+(?:user|system)\b[ \t\r\n]*)?([^;]*);`, "gim");
const DATABASE_DML = /\bDatabase\.(insert|update|upsert|delete|undelete|merge|insertImmediate|deleteImmediate|insertAsync|updateAsync|upsertAsync|deleteAsync)\s*\(/gi;
const TRIGGER = /^\s*trigger\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/im;
const NOT_A_TYPE = /^(?:return|new|else|throw|insert|update|upsert|delete|undelete|merge|if|for|while|catch|switch|do|try|when|case|as|and|or|not|instanceof)$/i;

/** One scope that can declare a variable: a method with its lines, or a class with its fields. */
interface Scope { fn?: FunctionInfo; cls: ClassInfo }

/** Every method of the file, innermost class owning each. */
function methodsOf(classes: readonly ClassInfo[]): Scope[] {
  return classes.flatMap((cls) => cls.methods.map((fn) => ({ fn, cls })));
}

/**
 * The declared type of variable `name` at `line`: a declaration inside the method that holds the line (the last one
 * before it, else the first), then a field of the class that declares the method and of the classes around it.
 */
function declaredType(name: string, line: number, lines: readonly string[], classes: readonly ClassInfo[], methods: readonly Scope[]): string | null {
  const owner = methods.filter((s) => s.fn!.line <= line && line <= s.fn!.endLine).sort((a, b) => (a.fn!.endLine - a.fn!.line) - (b.fn!.endLine - b.fn!.line))[0];
  if (owner) {
    const re = new RegExp(String.raw`(?<![\w.])([A-Za-z_][\w.]*(?:\s*<[^;=(){}]*>)?(?:\s*\[\s*\])?)\s+${name}\b\s*(?=[=;,):])`, "gi");
    const body = lines.slice(owner.fn!.line - 1, owner.fn!.endLine).join("\n");
    const hits = [...body.matchAll(re)].filter((m) => !NOT_A_TYPE.test(m[1]!) && !/\b(?:merge|as)\s*$/i.test(body.slice(Math.max(0, m.index! - 8), m.index!)));
    const before = hits.filter((m) => owner.fn!.line + body.slice(0, m.index!).split("\n").length - 1 <= line);
    const hit = before[before.length - 1] ?? hits[0];
    if (hit) return hit[1]!;
  }
  const around = classes.filter((c) => c.line <= line && line <= c.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line));
  for (const cls of around) {
    const field = cls.properties.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (field?.type) return field.type;
  }
  return null;
}

/** The SObject type a DML operand holds, from its text; null when the text states none. */
function operandObject(operand: string, line: number, lines: readonly string[], classes: readonly ClassInfo[], methods: readonly Scope[]): string | null {
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
      const declared = declaredType((values ?? bare)!, line, lines, classes, methods);
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
    } else if (c === "[" && /^\[\s*(?:SELECT|FIND)\b/i.test(text.slice(i, i + 24))) i = queryEnd(text, i);
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
  const parts = expr.split(/\+(?=(?:[^']*'[^']*')*[^']*$)/).map((p) => p.trim()).filter(Boolean);
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
  const starts = lineStarts(dataText);
  const lineOf = (offset: number): number => lineOfOffset(starts, offset);
  const lines = dataText.split("\n");
  const methods = methodsOf(classes);
  // Free functions (a trigger) scope their variables like methods.
  for (const fn of functions) if (!methods.some((s) => s.fn === fn)) methods.push({ fn, cls: classes[0] ?? ({ name: "", methods: [], properties: [], line: 0, endLine: 0 } as unknown as ClassInfo) });

  // Inline queries.
  for (let i = 0; i < dataText.length; i++) {
    const c = dataText[i]!;
    if (c === "'") i = stringEnd(dataText, i) - 1;
    else if (c === "[" && /^\[\s*(?:SELECT|FIND)\b/i.test(dataText.slice(i, i + 24))) {
      const end = queryEnd(dataText, i);
      const verb = /^\[\s*FIND\b/i.test(dataText.slice(i, i + 24)) ? "FIND" : "SELECT";
      for (const object of queryObjects(dataText.slice(i, end))) out.push(row(verb, object, "read", lineOf(i)));
      i = end - 1;
    }
  }

  // A query held in a string: `Database.query('SELECT …')`, `String q = 'SELECT …'`.
  for (const lit of literalsOf(dataText)) {
    if (!SOQL_STRING.test(lit.value)) continue;
    for (const object of queryObjects(lit.value)) out.push(row("SELECT", object, "read", lineOf(lit.start)));
  }

  // DML statements and `Database.*` calls.
  const code = blankStrings(dataText);
  for (const m of code.matchAll(DML)) {
    const verb = m[1]!.toUpperCase();
    const operand = m[2]!;
    if (/^\s*[(=.]/.test(operand)) continue;
    const at = m.index! + m[0].search(new RegExp(String.raw`\b${m[1]!}\b`, "i"));
    const line = lineOf(at);
    const type = operandObject(operand, line, lines, classes, methods);
    if (type) out.push(row(verb, type, "write", line));
  }
  for (const m of code.matchAll(DATABASE_DML)) {
    const open = m.index! + m[0].length - 1;
    const args = balancedArgs(code, open);
    if (!args) continue;
    const line = lineOf(m.index!);
    const type = operandObject(splitTopLevelCommas(args.args)[0] ?? "", line, lines, classes, methods);
    if (type) out.push(row(`Database.${m[1]!.toLowerCase()}`, type, "write", line));
  }

  // The object a trigger is declared on.
  const trigger = TRIGGER.exec(code);
  if (trigger) {
    const line = lineOf(trigger.index + trigger[0].indexOf("trigger"));
    out.push(row(`TRIGGER ${trigger[3]!.replace(/\s+/g, " ").trim()}`, trigger[2]!, undefined, line));
  }

  out.push(...callouts(dataText, starts, methods));
  return out.sort((a, b) => a.line - b.line);
}

/** `req.setEndpoint(…)` calls with the verb `req.setMethod('…')` states in the same method. */
function callouts(text: string, starts: number[], methods: readonly Scope[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const lines = text.split("\n");
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*setEndpoint\s*\(/gi)) {
    const open = m.index! + m[0].length - 1;
    const args = balancedArgs(text, open);
    if (!args) continue;
    const endpoint = endpointOf(args.args);
    if (endpoint === null) continue;
    const at = lineOfOffset(starts, m.index!);
    const owner = methods.filter((s) => s.fn!.line <= at && at <= s.fn!.endLine).sort((a, b) => (a.fn!.endLine - a.fn!.line) - (b.fn!.endLine - b.fn!.line))[0];
    const scope = owner ? lines.slice(owner.fn!.line - 1, owner.fn!.endLine).join("\n") : text;
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
