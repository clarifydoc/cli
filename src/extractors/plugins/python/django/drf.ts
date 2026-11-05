import type { Node } from "web-tree-sitter";
import type { ClassInfo, FileAnalysis, FunctionInfo } from "../../../../types/analysis.js";
import { resolvePythonImport } from "../module-resolver.js";
import { DJ_VIEW_CLASS, DRF_SERIALIZER_FIELDS, type DjViewClassFact, type DrfSerializerFieldsFact } from "./facts.js";

/**
 * What Django REST Framework's own code calls on a project's classes — the view
 * hooks a ViewSet action runs (`viewset-actions.ts`) and the serializer methods
 * `is_valid()` / `save()` run (`serializer-dispatch.ts`) — read over the
 * project's class chains. DRF's classes are library code: a step the project
 * does not override is DRF's own, followed into the steps IT takes; one the
 * project overrides is linked, and followed past only when it hands on with
 * `super().<name>(…)`.
 */

export interface ClassAt {
  cls: ClassInfo;
  file: FileAnalysis;
}

/** `rest_framework.viewsets.ModelViewSet[Club]` → `ModelViewSet`. */
export const bareName = (written: string): string => written.replace(/\[.*$/s, "").trim().split(".").pop()!;

const SUPER_CALL = /^super\s*\([^)]*\)\s*\.\s*(\w+)$/;

/** DRF's generic view bases: the ones supplying the actions and the hooks they call. */
export const DRF_GENERIC_VIEW = /^(?:ModelViewSet|ReadOnlyModelViewSet|GenericViewSet|GenericAPIView|(?:List|Create|Retrieve|Update|Destroy)ModelMixin|(?:List|Create|Retrieve|Destroy|Update|ListCreate|RetrieveUpdate|RetrieveDestroy|RetrieveUpdateDestroy)APIView)$/;
/** DRF's serializer bases. */
export const DRF_SERIALIZER = /^(?:BaseSerializer|Serializer|ModelSerializer|HyperlinkedModelSerializer|ListSerializer)$/;

/** The hooks DRF's view mixins and `GenericAPIView` call on the instance, by method (`serializer.*`: on its serializer). */
export const VIEW_CALLS: Record<string, readonly string[]> = {
  list: ["get_queryset", "filter_queryset", "paginate_queryset", "get_serializer", "serializer.data", "get_paginated_response"],
  create: ["get_serializer", "serializer.is_valid", "perform_create", "serializer.data", "get_success_headers"],
  retrieve: ["get_object", "get_serializer", "serializer.data"],
  update: ["get_object", "get_serializer", "serializer.is_valid", "perform_update", "serializer.data"],
  partial_update: ["update"],
  destroy: ["get_object", "perform_destroy"],
  get_object: ["get_queryset", "filter_queryset", "check_object_permissions"],
  get_serializer: ["get_serializer_class", "get_serializer_context"],
  perform_create: ["serializer.save:create"],
  perform_update: ["serializer.save:update"],
};

/**
 * What a serializer's library methods call on it: `is_valid` runs `run_validation`, which turns the data into values
 * (`to_internal_value`: each field's `validate_<field>` and the field's `validators=[…]`) and then calls `validate`;
 * `save` calls `create` without an instance and `update` with one (`save:create` / `save:update`).
 */
export const SERIALIZER_CALLS: Record<string, readonly string[]> = {
  is_valid: ["run_validation"],
  run_validation: ["to_internal_value", "validate"],
  "save:create": ["save", "create"],
  "save:update": ["save", "update"],
  // `.data` runs `to_representation`: the project's own, else the library's, which calls each method field's `get_<field>`.
  data: ["to_representation"],
};

/** Whether a serializer is built with an instance (`save()` updates) or with data alone (`save()` creates). */
export type SaveMode = "create" | "update";

const KEY_PREFIX = "drf-serializer:";

/** The function (or module) a node sits in, as text: where a local's later reads are looked for. */
function scopeTextOf(node: Node): string {
  let scope: Node | null = node.parent;
  while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
  return scope?.text ?? "";
}

/**
 * Whether the serializer a call builds has its `.data` read: straight off the call
 * (`ClubSerializer(club).data`), or off the local it is bound to (`s = ClubSerializer(club)` … `s.data`).
 */
function readsData(node: Node): boolean {
  let up: Node | null = node.parent;
  while (up?.type === "await") up = up.parent;
  if (up?.type === "attribute" && up.childForFieldName("attribute")?.text === "data") return true;
  if (up?.type !== "assignment" || up.childForFieldName("left")?.type !== "identifier") return false;
  const local = up.childForFieldName("left")!.text;
  return new RegExp(String.raw`\b${local}\.data\b`).test(scopeTextOf(node));
}

/**
 * `ClubSerializer(club, data=…)` / `self.get_serializer(instance=club, …)` → `drf-serializer:update`;
 * `ClubSerializer(data=…)` → `drf-serializer:create` — what its `save()` will call. A call
 * spreading its arguments, or passing neither, states no mode. A `:data` part says the serializer's
 * `.data` is read (`drf-serializer:update:data`): its `to_representation` runs.
 */
export function drfSerializerKey(node: Node, callName?: string): string | null {
  if (callName !== undefined) {
    const leaf = callName.split(".").pop()!;
    if (leaf !== "get_serializer" && !/^[A-Z]\w*Serializer$/.test(leaf)) return null;
  }
  if (node.type !== "call") return null;
  let instance = false;
  let data = false;
  let spread = false;
  for (const a of node.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "comment") continue;
    if (a.type === "list_splat" || a.type === "dictionary_splat") { spread = true; continue; }
    if (a.type !== "keyword_argument") instance = true;
    else {
      const k = a.childForFieldName("name")?.text;
      if (k === "instance") instance = true;
      else if (k === "data") data = true;
    }
  }
  const mode = spread ? null : instance ? "update" : data ? "create" : null;
  const reads = readsData(node);
  if (!mode && !reads) return null;
  return KEY_PREFIX + [mode, reads ? "data" : null].filter(Boolean).join(":");
}

const keyParts = (key: string | undefined): string[] => (key?.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length).split(":") : []);

/** The save mode a call's key states, if any. */
export const saveModeOf = (key: string | undefined): SaveMode | null => {
  const parts = keyParts(key);
  return parts.includes("update") ? "update" : parts.includes("create") ? "create" : null;
};

/** Whether a call's key says the serializer it builds has its `.data` read. */
export const readsSerializerData = (key: string | undefined): boolean => keyParts(key).includes("data");

/** The project's Python classes and functions by name, with their bases resolved through imports. */
export class PythonClassIndex {
  private readonly byName = new Map<string, ClassAt[]>();
  private readonly files = new Map<string, FileAnalysis>();
  private fileSet: ReadonlySet<string> | undefined;
  private readonly chains = new Map<ClassInfo, { chain: ClassAt[]; external: string[] }>();
  private readonly viewFacts = new Map<string, DjViewClassFact>();
  private readonly serializerFields = new Map<string, DrfSerializerFieldsFact>();

  constructor(analyses: FileAnalysis[]) {
    for (const a of analyses) {
      this.files.set(a.filePath, a);
      for (const cls of a.classes) (this.byName.get(cls.name) ?? this.byName.set(cls.name, []).get(cls.name)!).push({ cls, file: a });
      for (const f of a.routeFacts ?? []) {
        if (!f.owner) continue;
        if (f.kind === DJ_VIEW_CLASS) this.viewFacts.set(`${a.filePath}::${f.owner}`, f.data as DjViewClassFact);
        else if (f.kind === DRF_SERIALIZER_FIELDS) this.serializerFields.set(`${a.filePath}::${f.owner}`, f.data as DrfSerializerFieldsFact);
      }
    }
  }

  /** The file a module `source` names from `file` (`specifier`: the name imported from it), or null. */
  private moduleFile(file: string, source: string, specifier?: string): string | null {
    return resolvePythonImport(file, source, specifier, {
      files: (this.fileSet ??= new Set(this.files.keys())),
      declares: (f, name) => !!this.files.get(f)?.classes.some((c) => c.name === name) || !!this.files.get(f)?.functions.some((fn) => fn.name === name),
      globImportsOf: () => [],
    });
  }

  /**
   * Where `written` (`Club`, `checks.no_reserved_name`) is declared as `near` sees it: `near` itself, else the
   * project file an import names (`imported`: an import binds the name to a module outside the project).
   */
  private declaringFile(written: string, near: FileAnalysis, declares: (a: FileAnalysis, name: string) => boolean): { file: FileAnalysis | null; name: string; imported: boolean } {
    const parts = written.split(".");
    const name = parts.pop()!;
    if (parts.length === 0 && declares(near, name)) return { file: near, name, imported: false };
    const head = parts[0] ?? name;
    for (const imp of near.imports) {
      const local = Object.keys(imp.aliases ?? {}).find((l) => l === head);
      const exported = local ? imp.aliases![local]! : head;
      let target: string | null = null;
      if (imp.specifiers.includes(head) || local) {
        // `from league.checks import no_reserved_name`, or `from league import checks` + `checks.no_reserved_name`.
        if (parts.length > 1) continue;
        target = this.moduleFile(near.filePath, imp.source, exported);
      } else if (parts.length > 0 && imp.source === parts.join(".")) {
        target = this.moduleFile(near.filePath, imp.source); // `import league.checks` + `league.checks.no_reserved_name`
      } else continue;
      const a = target ? this.files.get(target) : undefined;
      // An import of no project module (a package's) names a library class; one re-exporting it from elsewhere, unknown.
      return { file: a && declares(a, name) ? a : null, name, imported: !a };
    }
    return { file: null, name, imported: false };
  }

  /** A class by name as `near` sees it: its own, an imported one, else (not a library's) the only one of that name. */
  classNamed(written: string, near: FileAnalysis): ClassAt | null {
    const hit = this.declaringFile(written.replace(/\[.*$/s, "").trim(), near, (a, n) => a.classes.some((c) => c.name === n));
    if (hit.file) return (this.byName.get(hit.name) ?? []).find((c) => c.file === hit.file) ?? null;
    if (hit.imported) return null;
    const all = this.byName.get(hit.name) ?? [];
    return all.length === 1 ? all[0]! : null;
  }

  /** A module-level function by name as `near` sees it. */
  functionNamed(written: string, near: FileAnalysis): { file: FileAnalysis; fn: FunctionInfo } | null {
    const hit = this.declaringFile(written, near, (a, n) => a.functions.some((f) => f.name === n));
    const fn = hit.file?.functions.find((f) => f.name === hit.name);
    return hit.file && fn ? { file: hit.file, fn } : null;
  }

  /** The project classes of a class's chain in resolution order, and the bases outside the project, bare. */
  chainOf(start: ClassAt): { chain: ClassAt[]; external: string[] } {
    const memo = this.chains.get(start.cls);
    if (memo) return memo;
    const chain: ClassAt[] = [];
    const external: string[] = [];
    const seen = new Set<ClassInfo>();
    // Depth-first, left to right: Python's order wherever the bases share no ancestor.
    const visit = (c: ClassAt, depth: number) => {
      if (seen.has(c.cls) || depth > 8) return;
      seen.add(c.cls);
      chain.push(c);
      for (const written of [c.cls.extends, ...c.cls.implements]) {
        if (!written) continue;
        const name = bareName(written);
        const base = name === c.cls.name ? null : this.classNamed(written, c.file);
        if (base) visit(base, depth + 1);
        else external.push(name);
      }
    };
    visit(start, 0);
    const out = { chain, external };
    this.chains.set(start.cls, out);
    return out;
  }

  /** The class-body attributes the route facts read off a class (`serializer_class`, …). */
  viewFact(c: ClassAt): DjViewClassFact | undefined {
    return this.viewFacts.get(`${c.file.filePath}::${c.cls.name}`);
  }

  /** The functions a class's fields name in `validators=[…]`. */
  validatorsOf(c: ClassAt): string[] {
    return this.serializerFields.get(`${c.file.filePath}::${c.cls.name}`)?.validators ?? [];
  }

  /** The methods the serializer's `SerializerMethodField`s run (`get_size`), declared on the class. */
  methodFieldsOf(c: ClassAt): string[] {
    return (this.serializerFields.get(`${c.file.filePath}::${c.cls.name}`)?.methodFields ?? []).map((f) => f.method);
  }

  /** `Meta.model` of the nearest serializer along the chain stating one, as written. */
  metaModelOf(chain: readonly ClassAt[]): { model: string; at: ClassAt } | null {
    for (const c of chain) {
      const model = this.serializerFields.get(`${c.file.filePath}::${c.cls.name}`)?.metaModel;
      if (model) return { model, at: c };
    }
    return null;
  }

  /** Whether a serializer whose chain this is has a field `name`: declared along it, or in the nearest `Meta.fields`. */
  hasField(chain: readonly ClassAt[], name: string): boolean {
    let meta: DrfSerializerFieldsFact["metaFields"];
    for (const c of chain) {
      const fact = this.serializerFields.get(`${c.file.filePath}::${c.cls.name}`);
      if (fact?.fields?.includes(name)) return true;
      meta ??= fact?.metaFields;
    }
    return meta === "__all__" || !!meta?.includes(name);
  }

  /**
   * The serializer a view hands its data to: the nearest `serializer_class` along its chain — when that is a
   * project serializer and no project class overrides `get_serializer_class` (which picks one at run time).
   */
  viewSerializer(chain: readonly ClassAt[]): ClassAt | null {
    if (chain.some((c) => c.cls.methods.some((m) => m.name === "get_serializer_class"))) return null;
    for (const c of chain) {
      const written = this.viewFact(c)?.serializerClass;
      if (!written) continue;
      const ser = this.classNamed(written, c.file);
      return ser && this.chainOf(ser).external.some((b) => DRF_SERIALIZER.test(b)) ? ser : null;
    }
    return null;
  }
}

/** The project method of this name nearest the start of the chain, at or after `from`. */
export function declaredAlong(chain: readonly ClassAt[], name: string, from = 0): { at: number; fn: FunctionInfo } | null {
  for (let i = from; i < chain.length; i++) {
    const fn = chain[i]!.cls.methods.find((m) => m.name === name);
    if (fn) return { at: i, fn };
  }
  return null;
}

export interface FollowVisitor {
  /** A project method that runs (the nearest override of a step). */
  declared(c: ClassAt, fn: FunctionInfo): void;
  /** A step the library runs itself: true when the visitor has handled it, false to follow the table. */
  library(name: string): boolean;
}

/**
 * What runs for `self.<name>()` from position `from` of the chain: the nearest
 * project method (handed to the visitor unless `linkDeclared` is false — the
 * caller's own), followed past only through `super().<name>()`; past the last
 * project class, the library's, whose steps `table` lists.
 */
export function follow(
  chain: readonly ClassAt[],
  name: string,
  table: Record<string, readonly string[]>,
  visitor: FollowVisitor,
  from = 0,
  linkDeclared = true,
  depth = 0,
): void {
  if (depth > 8) return;
  const decl = declaredAlong(chain, name, from);
  if (decl) {
    if (linkDeclared) visitor.declared(chain[decl.at]!, decl.fn);
    // Handed on to the base (a project base's, which the linker links, else the library's): what that runs.
    if (!decl.fn.calls.some((c) => SUPER_CALL.exec(c.name)?.[1] === name)) return;
    return follow(chain, name, table, visitor, decl.at + 1, false, depth + 1);
  }
  if (visitor.library(name)) return;
  for (const step of table[name] ?? []) follow(chain, step, table, visitor, 0, true, depth + 1);
}

/**
 * The serializer methods `serializer.<call>()` runs — `is_valid`, or `save` with
 * the mode its construction states — handed to `emit` with their class.
 */
export function serializerRuns(
  index: PythonClassIndex,
  serializer: ClassAt,
  call: "is_valid" | "save:create" | "save:update" | "data",
  emit: (file: FileAnalysis, symbol: string, line: number) => void,
  linkDeclared = true,
): void {
  const { chain } = index.chainOf(serializer);
  follow(chain, call, SERIALIZER_CALLS, {
    declared: (c, fn) => emit(c.file, `${c.cls.name}.${fn.name}`, fn.line),
    library(name) {
      if (name === "to_representation") {
        // The library's own: each `SerializerMethodField` runs its method on the instance.
        const seen = new Set<string>();
        for (const c of chain) {
          for (const method of index.methodFieldsOf(c)) {
            if (seen.has(method)) continue;
            seen.add(method);
            follow(chain, method, {}, { declared: (d, fn) => emit(d.file, `${d.cls.name}.${fn.name}`, fn.line), library: () => true });
          }
        }
        return true;
      }
      if (name !== "to_internal_value") return false;
      // Each field's own check and the functions its `validators=[…]` names.
      const seen = new Set<string>();
      for (const c of chain) {
        for (const m of c.cls.methods) {
          // DRF calls `validate_<field>(value)` for a field the serializer has, with the one value.
          if (!/^validate_\w+$/.test(m.name) || seen.has(m.name) || m.params.filter((p) => p.name !== "self").length !== 1) continue;
          if (!index.hasField(chain, m.name.slice("validate_".length))) continue;
          seen.add(m.name);
          follow(chain, m.name, {}, { declared: (d, fn) => emit(d.file, `${d.cls.name}.${fn.name}`, fn.line), library: () => true });
        }
        for (const v of index.validatorsOf(c)) {
          const fn = index.functionNamed(v, c.file);
          if (fn) emit(fn.file, fn.fn.name, fn.fn.line);
        }
      }
      return true;
    },
  }, 0, linkDeclared);
}
