import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";

/**
 * URL-builder template extraction. A frontend helper that returns an
 * app-relative request URL (`requestUri(endpoint, version)`) is captured as a
 * parameterized template — params as `{name}`, env base dropped, other runtime
 * refs as `{}` — so a project-level pass can substitute call-site args.
 */
async function templateOf(src: string, fnName: string): Promise<string | undefined> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  const fns = new JavaScriptExtractor().extractFunctions(tree, src);
  return fns.find((f) => f.name === fnName)?.urlTemplate;
}

/** `[urlTemplate, ...urlTemplateAlternatives]` of a free function or a class method. */
async function templatesOf(src: string, name: string): Promise<string[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  const x = new JavaScriptExtractor();
  const fn =
    x.extractFunctions(tree, src).find((f) => f.name === name) ??
    x.extractClasses(tree, src).flatMap((c) => c.methods).find((m) => m.name === name);
  return fn?.urlTemplate ? [fn.urlTemplate, ...(fn.urlTemplateAlternatives ?? [])] : [];
}

describe("URL-builder template extraction", () => {
  it("reads the path a returned helper call decorates, never a request call", async () => {
    const SRC = `export const getMatchStreamUrl = (id: string, sessionId: string) => {
      return createUrl(\`/matches/\${id}/stream/\${sessionId}\`, authManager.params);
    };
    export const loadMatch = (id: string) => fetch(\`/matches/\${id}\`);`;
    expect(await templateOf(SRC, "getMatchStreamUrl")).toBe("/matches/{id}/stream/{sessionId}");
    expect(await templateOf(SRC, "loadMatch")).toBeUndefined();
  });

  it("builds a template from a concat chain, dropping env base and runtime vars", async () => {
    const SRC = `export function requestUri(endpoint: string, version = 'v2'): string {
      const id = useStore().selectedInstitutionId;
      return import.meta.env.VITE_API + '/api/' + version + '/institution/' + id + '/' + endpoint;
    }`;
    expect(await templateOf(SRC, "requestUri")).toBe("/api/{version}/institution/{}/{endpoint}");
  });

  it("follows a one-hop local const and a template literal return", async () => {
    const SRC = `export function adminUri(aSubPath: string, version = 'v1'): string {
      const str = import.meta.env.VITE_ADMIN + \`/api/\${version}/\${aSubPath}\`;
      return str;
    }`;
    expect(await templateOf(SRC, "adminUri")).toBe("/api/{version}/{aSubPath}");
  });

  it("handles an expression-bodied arrow", async () => {
    const SRC = `export const uri = (sub: string) => '/api/' + sub;`;
    expect(await templateOf(SRC, "uri")).toBe("/api/{sub}");
  });

  it("does not set a template for a non-URL function (no slash)", async () => {
    const SRC = `export function label(name: string) { return 'prefix-' + name; }`;
    expect(await templateOf(SRC, "label")).toBeUndefined();
  });
});

async function classesOf(src: string) {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptExtractor().extractClasses(tree, src);
}

/**
 * Property facts the request-schema pass consumes: field decorators (children
 * of the field, unlike a method's), the `?` optional marker, constructor
 * parameter properties, and interface optionals.
 */
describe("class properties — decorators, optional marker, parameter properties", () => {
  it("keeps class-validator/transformer decorators with arguments and marks required fields", async () => {
    const [dto] = await classesOf(`export class CreatePlayerDto extends BaseDto {
      @IsString()
      @Expose({ name: 'player_name' })
      playerName: string;

      @IsOptional() @IsInt()
      age?: number;

      tags: string[] = [];

      private secret: string;
      static VERSION = 1;
    }`);
    expect(dto!.extends).toBe("BaseDto");
    expect(dto!.properties).toEqual([
      { name: "playerName", type: "string", visibility: null, isStatic: false, isReadonly: false, decorators: ["IsString()", "Expose({ name: 'player_name' })"], isRequired: true },
      { name: "age", type: "number", visibility: null, isStatic: false, isReadonly: false, decorators: ["IsOptional()", "IsInt()"], isRequired: false },
      { name: "tags", type: "string[]", visibility: null, isStatic: false, isReadonly: false, decorators: [], isRequired: false },
      { name: "secret", type: "string", visibility: "private", isStatic: false, isReadonly: false, decorators: [], isRequired: true },
      { name: "VERSION", type: null, visibility: null, isStatic: true, isReadonly: false, decorators: [], isRequired: false },
    ]);
  });

  it("turns constructor parameter properties into properties", async () => {
    const [cls] = await classesOf(`class Point {
      constructor(public readonly x: number, private y?: number, z: string = '', readonly label: string) {}
    }`);
    expect(cls!.properties).toEqual([
      { name: "x", type: "number", visibility: "public", isStatic: false, isReadonly: true, decorators: [], isRequired: true },
      { name: "y", type: "number", visibility: "private", isStatic: false, isReadonly: false, decorators: [], isRequired: false },
      { name: "label", type: "string", visibility: "public", isStatic: false, isReadonly: true, decorators: [], isRequired: true },
    ]);
  });

  it("marks optional interface members", async () => {
    const [iface] = await classesOf(`interface Q { q: string; page?: number }`);
    expect(iface!.properties.map((p) => [p.name, p.isRequired])).toEqual([["q", true], ["page", false]]);
  });
});

/**
 * A handler declared away from its route (`router.get('/', getPlayers)`) has
 * no bindings in its signature; what its body reads off `req` is recorded so
 * the project-level join can hand it to the route.
 */
describe("requestAccess on handler-shaped functions", () => {
  it("records request reads for functions and methods whose first param is req/request/ctx", async () => {
    const src = `export async function getPlayer(req: Request, res: Response) {
      const player = await find(req.params.id, req.query.expand);
      res.json(player);
    }
    export const login = (request, reply) => { const { email, password } = request.body; };
    export class Ctl { async remove(req, res) { await del(req.params['id']); } }
    export function helper(a, b) { return a.params.id; }
    export function none(req, res) { res.end(); }`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const ex = new JavaScriptExtractor();
    const fns = ex.extractFunctions(tree, src);
    const by = (n: string) => fns.find((f) => f.name === n)!;
    expect(by("getPlayer").requestAccess).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "expand", type: null, binding: "query" },
    ]);
    expect(by("login").requestAccess).toEqual([
      { name: "email", type: null, binding: "body" },
      { name: "password", type: null, binding: "body" },
    ]);
    expect(by("helper").requestAccess).toBeUndefined();
    expect(by("none").requestAccess).toBeUndefined();
    const [ctl] = ex.extractClasses(tree, src);
    expect(ctl!.methods[0]!.requestAccess).toEqual([{ name: "id", type: null, binding: "route" }]);
  });
});

describe("URL-builder template extraction — branches and methods", () => {
  it("captures a class method's template, dropping a runtime config base", async () => {
    // A service singleton's method is as common a helper as a free function;
    // the base read off a store is a base, not a `{}` path segment.
    const SRC = `class ConfigService {
      APIUrl(aSubPath: string): string {
        return store.state.mainConfig.APP_API_URL + "/api/" + aSubPath;
      }
    }`;
    expect(await templatesOf(SRC, "APIUrl")).toEqual(["/api/{aSubPath}"]);
  });

  it("folds an if/else mock switch whose branches differ only in the base into one template", async () => {
    const SRC = `class ConfigService {
      APIUrl(aSubPath: string): string {
        if (import.meta.env.VITE_MOCKDATA === "true") {
          return "http://localhost/api/" + aSubPath;
        } else {
          return store.state.mainConfig.APP_API_URL + "/api/" + aSubPath;
        }
      }
    }`;
    expect(await templatesOf(SRC, "APIUrl")).toEqual(["/api/{aSubPath}"]);
  });

  it("keeps both arms of a returned ternary as primary + alternative, in source order", async () => {
    const SRC = `class ConfigService {
      staffOrAdminUrl(aSubPath: string): string {
        const user = store.getters["security/getUser"]();
        if (import.meta.env.VITE_MOCKDATA === "true") {
          return user && isEmployee(user)
            ? "http://localhost/api/staff/" + aSubPath
            : "http://localhost/api/" + aSubPath;
        } else {
          return user && isEmployee(user)
            ? store.state.mainConfig.APP_API_URL + "/api/staff/" + aSubPath
            : store.state.mainConfig.APP_API_URL + "/api/" + aSubPath;
        }
      }
    }`;
    expect(await templatesOf(SRC, "staffOrAdminUrl")).toEqual(["/api/staff/{aSubPath}", "/api/{aSubPath}"]);
  });

  it("follows an else-if chain and a bare-statement branch", async () => {
    const SRC = `export function uri(kind: string, sub: string): string {
      if (kind === "a") return "/a/" + sub;
      else if (kind === "b") return "/b/" + sub;
      else return "/c/" + sub;
    }`;
    expect(await templatesOf(SRC, "uri")).toEqual(["/a/{sub}", "/b/{sub}", "/c/{sub}"]);
  });

  it("ignores a guard return that is not a URL", async () => {
    const SRC = `export function uri(sub: string | null): string | null {
      if (!sub) return null;
      return "/api/" + sub;
    }`;
    expect(await templatesOf(SRC, "uri")).toEqual(["/api/{sub}"]);
  });
});

describe("JS class field values", () => {
  it("records initializers and constructor assignments as URL strings with holes", async () => {
    const [cls] = await classesOf(`
      export class TagService extends AbstractService {
        baseUrl = environment.apiUrl + 'tags/';
        constructor(http) { super(http); this.resourceName = 'tags'; this.http = http; }
      }`);
    expect(cls!.fieldValues).toEqual({
      baseUrl: "${environment.apiUrl}tags/",
      resourceName: "tags",
      http: "${http}",
    });
  });

  it("reads a same-file string constant a field is set from", async () => {
    const [cls] = await classesOf(`
      const endpoint = 'players'
      export class PlayerService extends AbstractNameFilterService {
        constructor() { super(); this.resourceName = endpoint; this.other = elsewhere }
      }`);
    expect(cls!.fieldValues).toEqual({ resourceName: "players", other: "${elsewhere}" });
  });

  it("records nothing for a field given two different values", async () => {
    const [cls] = await classesOf(`class A { url = '/a'; constructor() { this.url = '/b'; } }`);
    expect(cls!.fieldValues).toBeUndefined();
  });
});

describe("URL-builder template extraction — guarded appends", () => {
  it("emits one template per combination of parameter-guarded appends, fields kept as holes (paperless)", async () => {
    const SRC = `class AbstractPaperlessService {
      protected getResourceUrl(id: number = null, action: string = null): string {
        let url = \`\${this.baseUrl}\${this.resourceName}/\`;
        if (id !== null) {
          url += \`\${id}/\`;
        }
        if (action) {
          url += \`\${action}/\`;
        }
        return url;
      }
    }`;
    expect(await templatesOf(SRC, "getResourceUrl")).toEqual([
      "${this.baseUrl}${this.resourceName}/",
      "${this.baseUrl}${this.resourceName}/{id}/",
      "${this.baseUrl}${this.resourceName}/{action}/",
      "${this.baseUrl}${this.resourceName}/{id}/{action}/",
    ]);
  });
});

describe("JavaScriptExtractor — a registry keyed by a constant", () => {
  it("makes each `[KEY]:` handler a function and each creator naming KEY a function calling it", async () => {
    const src = `import { createThunk, handleThunks } from 'Store/thunks';
export const FETCH_MOVIES = 'movies/fetchMovies';
export const DELETE_MOVIE = 'movies/deleteMovie';
export const fetchMovies = createThunk(FETCH_MOVIES);
export const deleteMovie = createThunk(DELETE_MOVIE, (payload) => payload);
export const setSort = createAction(SET_SORT);
export const actionHandlers = handleThunks({
  [FETCH_MOVIES]: createFetchHandler(section, '/movie'),
  [DELETE_MOVIE]: (getState, payload, dispatch) => {
    createRemoveItemHandler(section, '/movie')(getState, payload, dispatch);
  },
});
const lookup = { [FETCH_MOVIES]: 1 };`;
    const tree = await parseSource(src, "typescript" as never, "movieActions.js");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const view = fns.filter((f) => /\[|fetchMovies|deleteMovie|setSort/.test(f.name)).map((f) => `${f.name}@${f.line} -> ${f.calls.map((c) => c.name).join(",")}`);
    expect(view).toEqual([
      // \`section\` is an identifier argument, kept as a possible callback like in any body.
      "[FETCH_MOVIES]@8 -> createFetchHandler,section",
      "[DELETE_MOVIE]@9 -> createRemoveItemHandler,section",
      "fetchMovies@4 -> [FETCH_MOVIES]",
      "deleteMovie@5 -> [DELETE_MOVIE]",
    ]);
  });
});

describe("JavaScriptExtractor — arrow class fields", () => {
  it("makes `onSave = () => {…}` a method of its class (React class components)", async () => {
    const src = `class AddNewMovie extends Component {
  state = { term: '' };
  onSearchInputChange = ({ value }) => {
    this.props.onMovieLookupChange(value);
  };
  render() { return null; }
}`;
    const tree = await parseSource(src, "javascript" as never, "AddNewMovie.js");
    const [cls] = new JavaScriptExtractor().extractClasses(tree, src);
    expect(cls!.methods.map((m) => `${m.name}@${m.line}`)).toEqual(["onSearchInputChange@3", "render@6"]);
    expect(cls!.methods[0]!.calls.map((c) => c.name)).toEqual(["this.props.onMovieLookupChange"]);
  });

  it("makes `this.onSave = (e) => {…}` in the constructor a method, with its own calls (real-repo FP)", async () => {
    const src = `class CommentInput extends React.Component {
  constructor() {
    super();
    this.state = { body: '' };
    this.setBody = ev => {
      this.setState({ body: ev.target.value });
    };
    this.createComment = ev => {
      ev.preventDefault();
      const payload = agent.Comments.create(this.props.slug, { body: this.state.body });
      this.props.onSubmit(payload);
    };
    this.label = 'Post';
  }
  render() { return null; }
}`;
    const tree = await parseSource(src, "javascript" as never, "CommentInput.js");
    const [cls] = new JavaScriptExtractor().extractClasses(tree, src);
    expect(cls!.methods.map((m) => `${m.name}@${m.line}`)).toEqual(["constructor@2", "render@15", "setBody@5", "createComment@8"]);
    expect(cls!.methods.find((m) => m.name === "createComment")!.calls.map((c) => c.name)).toContain("agent.Comments.create");
    expect(cls!.methods.find((m) => m.name === "constructor")!.calls.map((c) => c.name)).toEqual([]);
  });
});

describe("JavaScriptExtractor — connect(…, mapDispatchToProps)", () => {
  it("adds the bound action creator to a `this.props.x()` call", async () => {
    const src = `import { clearAddMovie, lookupMovie } from 'Store/Actions/addMovieActions';
const mapDispatchToProps = { lookupMovie, dispatchClear: clearAddMovie };
class AddNewMovieConnector extends Component {
  onMovieLookupChange = (term) => { this.props.lookupMovie({ term }); };
  onClear() { this.props.dispatchClear(); this.props.onModalClose(); }
}
export default connect(createMapStateToProps, mapDispatchToProps)(AddNewMovieConnector);`;
    const tree = await parseSource(src, "javascript" as never, "AddNewMovieConnector.js");
    const [cls] = new JavaScriptExtractor().extractClasses(tree, src);
    expect(cls!.methods.map((m) => `${m.name}: ${m.calls.map((c) => c.name).join(",")}`)).toEqual([
      "onMovieLookupChange: this.props.lookupMovie,lookupMovie",
      "onClear: this.props.dispatchClear,this.props.onModalClose,clearAddMovie",
    ]);
  });
});

describe("JavaScriptExtractor — function-form mapDispatchToProps", () => {
  it("extracts each returned member and adds it to a `this.props.x()` call", async () => {
    const src = `import agent from '../agent';
const mapDispatchToProps = dispatch => ({
  onSaveClub: club => dispatch({ type: CLUB_SAVED, payload: agent.Clubs.save(club) }),
  onLeave: () => dispatch({ type: LEAVE }),
});
class ClubSettings extends React.Component {
  submit(club) { this.props.onSaveClub(club); }
}
export default connect(mapStateToProps, mapDispatchToProps)(ClubSettings);`;
    const tree = await parseSource(src, "javascript" as never, "ClubSettings.js");
    const extractor = new JavaScriptExtractor();
    const fns = extractor.extractFunctions(tree, src);
    expect(fns.map((f) => `${f.name}: ${f.calls.map((c) => c.name).join(",")}`)).toContain("mapDispatchToProps.onSaveClub: dispatch,agent.Clubs.save");
    expect(fns.map((f) => f.name)).toContain("mapDispatchToProps.onLeave");
    const [cls] = extractor.extractClasses(tree, src);
    expect(cls!.methods[0]!.calls.map((c) => c.name)).toEqual(["this.props.onSaveClub", "mapDispatchToProps.onSaveClub"]);
  });
});

describe("TypeScript namespaces", () => {
  it("extracts the classes a namespace block holds, nested or exported", async () => {
    const classes = await classesOf(`
export namespace NS { export class InNs { run() { return 1; } } }
namespace Billing.Core { export class Bill { total() { return 2; } } }
export class Top {}`);
    expect(classes.map((c: { name: string; methods: { name: string }[] }) => `${c.name}[${c.methods.map((m) => m.name)}]`).sort()).toEqual(["Bill[total]", "InNs[run]", "Top[]"]);
  });
});

describe("a function handed to a library option", () => {
  it("is a call of that function from the body that hands it over", async () => {
    const src = `import { useMutation, useQuery } from '@tanstack/vue-query';
import trainingService from './TrainingService';
export const useUpdateTrainingMutation = () =>
  useMutation({
    mutationFn: trainingService.updateTraining,
    onSuccess: () => invalidate(),
  });
export function useTrainings(id) {
  return useQuery({ queryKey: ['a', id], queryFn: fetchTrainings });
}`;
    const tree = await parseSource(src, "typescript" as any, "TrainingQueries.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const callsOf = (name: string) => fns.find((f) => f.name === name)?.calls.map((c) => c.name) ?? [];
    expect(callsOf("useUpdateTrainingMutation")).toEqual(expect.arrayContaining(["useMutation", "trainingService.updateTraining"]));
    expect(callsOf("useTrainings")).toEqual(expect.arrayContaining(["useQuery", "fetchTrainings"]));
  });
});

describe("URL-builder template extraction — a local given a value per branch", () => {
  it("makes one template per value a declared-empty local is assigned, ternary arms included", async () => {
    const SRC = `export function kitEndpoint(params: { clubId?: number; kind?: string; isAway?: boolean }): string {
      const { clubId, kind, isAway = false } = params
      if (clubId) {
        let endpoint: string
        if (kind === 'shirt') {
          endpoint = \`/api/league/clubs/\${clubId}/shirt\`
        } else if (kind === 'badge') {
          endpoint = isAway ? '/api/league/badges/away' : '/api/league/badges/home'
        } else {
          throw new Error('unknown kit')
        }
        return \`\${endpoint}?away=\${isAway}\`
      }
      return '/api/league/kits'
    }`;
    expect(await templatesOf(SRC, "kitEndpoint")).toEqual([
      "/api/league/clubs/${clubId}/shirt?away=${isAway}",
      "/api/league/badges/away?away=${isAway}",
      "/api/league/badges/home?away=${isAway}",
      "/api/league/kits",
    ]);
  });
});

describe("Pinia stores", () => {
  async function extract(src: string) {
    const tree = await parseSource(src, "typescript" as any, "club-store.ts");
    const x = new JavaScriptExtractor();
    return { functions: x.extractFunctions(tree, src), classes: x.extractClasses(tree, src) };
  }

  it("reads an option store as a class of its actions and getters, returned by the store's binding", async () => {
    const { functions, classes } = await extract(`import { defineStore } from 'pinia'
export const useClubStore = defineStore('club', {
  state: () => ({ clubs: [], url: "/api/league/clubs", season: \`/api/league/seasons/\${SEASON}\`, loading: false }),
  getters: {
    count: (state) => state.clubs.length,
    byId(state) { return (id) => state.clubs.find((c) => c.id === id) },
  },
  actions: {
    async load() { this.clubs = (await axios.get(this.url)).data },
    async delete(id: number) { await axios.delete(\`\${this.url}/\${id}\`); this.drop(id) },
    drop: function (id: number) { this.clubs.splice(id, 1) },
  },
})`);
    const store = functions.find((f) => f.name === "useClubStore")!;
    expect([store.returnType, store.isExported]).toEqual(["ClubStore", true]);
    const cls = classes.find((c) => c.name === "ClubStore")!;
    expect(cls.methods.map((m) => m.name)).toEqual(["count", "byId", "load", "delete", "drop"]);
    expect(cls.methods.find((m) => m.name === "delete")!.calls.map((c) => c.name)).toEqual(["axios.delete", "this.drop"]);
    expect(cls.fieldValues).toEqual({ url: "/api/league/clubs", season: "/api/league/seasons/${SEASON}" });
    // The actions are the class's, not free functions named by their key.
    expect(functions.map((f) => f.name)).not.toContain("delete");
  });

  it("reads `defineStore({ id, … })` and `state() { return { … } }` the same way", async () => {
    const { classes } = await extract(`export const usePlayerStore = defineStore({
  id: 'players',
  state() { return { endpoint: '/api/league/players' } },
  actions: { fetch() { return axios.get(this.endpoint) } },
})`);
    expect(classes.map((c) => [c.name, c.methods.map((m) => m.name), c.fieldValues])).toEqual([
      ["PlayerStore", ["fetch"], { endpoint: "/api/league/players" }],
    ]);
  });

  it("reads a setup store's returned functions as members calling the function they name", async () => {
    const { functions, classes } = await extract(`export const useSquadStore = defineStore('squad', () => {
  const players = ref([])
  const captain = computed(() => players.value[0])
  async function load(id: number) { players.value = (await axios.get(\`/api/league/squads/\${id}\`)).data }
  const transfer = async (id: number) => axios.post(\`/api/league/players/\${id}/transfer\`)
  return { players, captain, load, sell: transfer }
})`);
    const store = functions.find((f) => f.name === "useSquadStore")!;
    expect(store.returnType).toBe("SquadStore");
    expect(functions.map((f) => f.name)).toEqual(expect.arrayContaining(["load", "transfer"]));
    // Refs and computeds are state, not members to call.
    expect(classes.find((c) => c.name === "SquadStore")!.methods.map((m) => `${m.name} -> ${m.calls.map((c) => c.name).join(",")}`)).toEqual([
      "load -> load",
      "sell -> transfer",
    ]);
  });

  it("leaves a store defined inside a function, and a defineStore that is not Pinia's shape, alone", async () => {
    const { functions, classes } = await extract(`function make() { const useGarageStore = defineStore('garage', { actions: { park() {} } }); return useGarageStore }
export const useCarStore = defineStore('car')`);
    expect(classes).toEqual([]);
    expect(functions.map((f) => f.name)).toEqual(["make"]);
  });
});

describe("a typed function value", () => {
  it("reads `(async (…) => {…}) satisfies PageLoad` as the binding's function (real-repo FP: 67 SvelteKit loaders empty)", async () => {
    const src = `import type { PageLoad } from './$types';
export const load = (async ({ url }) => {
  const fixtures = await getAllFixtures({ season: url.searchParams.get('season') });
  return { fixtures };
}) satisfies PageLoad;
export enum MatchKind { League = 'league', Cup = 'cup', Friendly }`;
    const tree = await parseSource(src, "typescript" as any, "+page.ts");
    const x = new JavaScriptExtractor();
    const load = x.extractFunctions(tree, src).find((f) => f.name === "load");
    expect(load?.calls.map((c) => c.name)).toContain("getAllFixtures");
    expect(x.extractClasses(tree, src).find((c) => c.name === "MatchKind")).toMatchObject({ kind: "enum", fieldValues: { League: "league", Cup: "cup" } });
  });
});

describe("Alpine components", () => {
  it("declares the members of an object an exported arrow returns, or Alpine.data registers", async () => {
    const names = async (src: string) => {
      const tree = await parseSource(src, "javascript" as any, "kit-picker.js");
      return new JavaScriptExtractor().extractFunctions(tree, src).map((f) => f.name);
    };
    expect(await names(`export default (id) => ({
  selected: null,
  setFocus(f) { this.focus = f },
  open() { this.isOpen = true },
  close: () => {},
})`)).toEqual(expect.arrayContaining(["setFocus", "open", "close"]));
    expect(await names(`Alpine.data('kitPicker', (id) => ({ choose(k) { this.kit = k } }))`)).toEqual(expect.arrayContaining(["choose"]));
  });
});

describe("URL templates built by joining parts", () => {
  it("keeps one hole per joined segment", async () => {
    expect(await templateOf("const kitUrl = (sel) => `/kits/${[sel.club, sel.season, sel.colour].map(encodeURIComponent).join('/')}`;", "kitUrl")).toBe("/kits/${sel.club}/${sel.season}/${sel.colour}");
    expect(await templateOf("function squadUrl(club, season) { return ['/api', 'clubs', club, 'squads', season].join('/'); }", "squadUrl")).toBe("/api/clubs/{club}/squads/{season}");
  });
});

describe("an exported factory returning an object of functions", () => {
  it("names each member a function of its own, so a request belongs to its operation (real-repo FP)", async () => {
    const src = `export const ClubsApiAxiosParamCreator = function (configuration?: Configuration) {
    return {
        createClub: async (club?: Club, options = {}) => {
            const localVarPath = \`/api/v2/clubs\`;
            return { url: localVarPath, options };
        },
        deleteClub: async (name: string, options = {}) => {
            const localVarPath = \`/api/v2/clubs/{name}\`;
            return { url: localVarPath, options };
        },
    }
};
export const settings = function () {
    return { theme: 'dark', save: () => {} }
};
`;
    const tree = await parseSource(src, "typescript" as any, "clubs-api.ts");
    const names = new JavaScriptExtractor().extractFunctions(tree, src).map((f) => `${f.name}@${f.line}`);
    // An object holding data besides functions is no namespace of functions.
    expect(names).toEqual(["ClubsApiAxiosParamCreator@1", "ClubsApiAxiosParamCreator.createClub@3", "ClubsApiAxiosParamCreator.deleteClub@7", "settings@13"]);
  });
});

describe("legacy widgets declared by assignment inside an IIFE (real-repo FP)", () => {
  it("records a namespace function and its prototype methods as functions", async () => {
    const src = `(function() {
  LEAGUE.app.widget.KickoffPicker = function(containerId, targetId) {
    this.targetId = targetId;
    this.hide();
  }
  LEAGUE.app.widget.KickoffPicker.prototype._onShow = function(type, args) {
    LEAGUE.util.Dom.setXY(this.containerId, xy);
  }
})();
function init() { window.onload = function () { start(); }; }`;
    const tree = await parseSource(src, "javascript" as any, "kickoff-picker.js");
    const names = new JavaScriptExtractor().extractFunctions(tree, src).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["KickoffPicker", "KickoffPicker._onShow", "init"]));
    // An assignment inside a function body stays that function's callback.
    expect(names).not.toContain("onload");
  });
});
