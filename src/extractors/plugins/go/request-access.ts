import type { ParamInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";

/**
 * What a Go handler body reads from the request. A Go route registration
 * names the handler and nothing else (`r.GET("/users/:id", h.GetUser)`), and
 * the handler's own signature is fixed by the framework (`c *gin.Context` /
 * `w, r`) — so the only place the request shape is visible is the body:
 *
 *   var input store.Product          ─┐
 *   c.ShouldBindJSON(&input)          ─┘ → body `input` typed store.Product
 *   json.NewDecoder(r.Body).Decode(&req)  → body `req` typed by its declaration
 *   c.ShouldBindQuery(&f) / c.ShouldBindUri(&p) / c.ShouldBindHeader(&h)
 *   c.Param("id") / r.PathValue("id") / chi.URLParam(r, "id") / mux.Vars(r)["id"] / ps.ByName("id")
 *   c.Query("q") / c.DefaultQuery("q", d) / r.URL.Query().Get("q")
 *   c.PostForm("f") / r.FormValue("f") / r.FormFile("f")
 *   c.GetHeader("X") / r.Header.Get("X")
 *
 * The result lands on `FunctionInfo.requestAccess`; the project-level join
 * copies it onto the route naming this handler. Runs on every function, so
 * each pattern is gated on the framework call shape, never on a receiver name.
 */

/** `var x T` / `var x *T` / `x := T{}` / `x := &T{}` / `x := new(T)` / `var x = T{}`. */
const VAR_DECL_RE = /^\s*var\s+([a-zA-Z_]\w*)\s+\*?([\w.\[\]]+)\s*$/;
const VAR_INIT_RE = /^\s*var\s+([a-zA-Z_]\w*)\s*=\s*&?([\w.\[\]]+)\s*\{/;
const SHORT_LIT_RE = /^\s*([a-zA-Z_]\w*)\s*:=\s*&?([\w.\[\]]+)\s*\{/;
const SHORT_NEW_RE = /^\s*([a-zA-Z_]\w*)\s*:=\s*new\s*\(\s*([\w.\[\]]+)\s*\)/;

/** `X.ShouldBindJSON(&v)` and the rest of the typed-binding family → binding. */
const TYPED_BIND: Array<{ re: RegExp; binding: RouteParamBinding }> = [
  { re: /\.\s*(?:ShouldBindJSON|BindJSON|ShouldBind|Bind|MustBindWith|ShouldBindBodyWith|ShouldBindXML|BindXML|ShouldBindYAML|BindYAML|ShouldBindTOML|BodyParser)\s*\(\s*&?([a-zA-Z_]\w*)/g, binding: "body" },
  { re: /json\.NewDecoder\s*\([^)]*\.Body\s*\)\s*\.\s*Decode\s*\(\s*&?([a-zA-Z_]\w*)/g, binding: "body" },
  { re: /\.\s*(?:ShouldBindQuery|BindQuery|QueryParser)\s*\(\s*&?([a-zA-Z_]\w*)/g, binding: "query" },
  { re: /\.\s*(?:ShouldBindUri|BindUri|ParamsParser)\s*\(\s*&?([a-zA-Z_]\w*)/g, binding: "route" },
  { re: /\.\s*(?:ShouldBindHeader|BindHeader|ReqHeaderParser)\s*\(\s*&?([a-zA-Z_]\w*)/g, binding: "header" },
  { re: /\.\s*ShouldBindWith\s*\(\s*&?([a-zA-Z_]\w*)\s*,\s*binding\.Form/g, binding: "form" },
];

/** `X.Method("name")` accessors whose first argument names the field. */
const NAMED_ACCESS: Array<{ re: RegExp; binding: RouteParamBinding }> = [
  { re: /\.\s*(?:Param|Params|PathValue)\s*\(\s*"([\w.-]+)"/g, binding: "route" },
  { re: /\.\s*Params\s*\.\s*ByName\s*\(\s*"([\w.-]+)"/g, binding: "route" },
  { re: /\bchi\.URLParam\s*\(\s*\w+\s*,\s*"([\w.-]+)"/g, binding: "route" },
  { re: /\bmux\.Vars\s*\(\s*\w+\s*\)\s*\[\s*"([\w.-]+)"/g, binding: "route" },
  { re: /\b\w+\.ByName\s*\(\s*"([\w.-]+)"/g, binding: "route" },
  { re: /\.\s*(?:Query|DefaultQuery|GetQuery|QueryArray|QueryMap|QueryParam|QueryParams)\s*\(\s*"([\w.-]+)"/g, binding: "query" },
  { re: /\.URL\.Query\s*\(\s*\)\s*\.\s*Get\s*\(\s*"([\w.-]+)"/g, binding: "query" },
  { re: /\.\s*(?:PostForm|DefaultPostForm|GetPostForm|PostFormArray|FormValue|PostFormValue|FormFile)\s*\(\s*"([\w.-]+)"/g, binding: "form" },
  { re: /\.\s*(?:GetHeader)\s*\(\s*"([\w.-]+)"/g, binding: "header" },
  { re: /\.Header\s*\.\s*Get\s*\(\s*"([\w.-]+)"/g, binding: "header" },
  { re: /\.Header\s*\(\s*\)\s*\.\s*Get\s*\(\s*"([\w.-]+)"/g, binding: "header" },
];

/** `vars := mux.Vars(r)` / `q := r.URL.Query()` — later `vars["id"]` / `q.Get("x")` read through the alias. */
const VARS_ALIAS_RE = /^\s*([a-zA-Z_]\w*)\s*:=\s*mux\.Vars\s*\(/;
const QUERY_ALIAS_RE = /^\s*([a-zA-Z_]\w*)\s*:=\s*\w+(?:\.Request)?\.URL\.Query\s*\(\s*\)\s*$/;

export function extractGoRequestAccess(bodyLines: string[], _fn: { name: string; params: ParamInfo[] }): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, type: string | null, binding: RouteParamBinding): void => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type, binding });
  };

  const localTypes = new Map<string, string>();
  const varsAliases = new Set<string>();
  const queryAliases = new Set<string>();

  for (const raw of bodyLines) {
    const line = raw.replace(/\/\/.*$/, "");
    if (!line.trim()) continue;

    const decl = line.match(VAR_DECL_RE) ?? line.match(VAR_INIT_RE) ?? line.match(SHORT_LIT_RE) ?? line.match(SHORT_NEW_RE);
    if (decl) localTypes.set(decl[1]!, decl[2]!);
    const varsAlias = line.match(VARS_ALIAS_RE);
    if (varsAlias) varsAliases.add(varsAlias[1]!);
    const queryAlias = line.match(QUERY_ALIAS_RE);
    if (queryAlias) queryAliases.add(queryAlias[1]!);

    for (const { re, binding } of TYPED_BIND) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) add(m[1]!, localTypes.get(m[1]!) ?? null, binding);
    }
    for (const { re, binding } of NAMED_ACCESS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) add(m[1]!, null, binding);
    }
    for (const alias of varsAliases) {
      const re = new RegExp(`\\b${alias}\\s*\\[\\s*"([\\w.-]+)"`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) add(m[1]!, null, "route");
    }
    for (const alias of queryAliases) {
      const re = new RegExp(`\\b${alias}\\s*\\.\\s*Get\\s*\\(\\s*"([\\w.-]+)"`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) add(m[1]!, null, "query");
    }
  }
  return out;
}
