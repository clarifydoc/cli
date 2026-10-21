import { describe, it, expect } from "vitest";
import { perlSpec } from "./index.js";
import { perlRequestSchema } from "./request-schema.js";
import { extractCatalystRequestAccess } from "./web.js";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import type { RouteInfo } from "../../../types/analysis.js";

const lines = (src: string) => src.split("\n");
const routes = (src: string): RouteInfo[] => perlSpec.extractRoutes!(lines(src), [], "lib/App/Controller/X.pm", []);
const sig = (r: RouteInfo) => `${r.httpMethod} ${r.path} -> ${r.handler}`;

const CONTROLLER = `
package MyApp::Controller::Admin::Players;
use Moose;
BEGIN { extends 'Catalyst::Controller'; }

sub auto :Private {
    my ($self, $c) = @_;
    return 1 if $c->user_exists;
    $c->response->redirect($c->uri_for('/auth/login'));
}

sub index :Path :Args(0) {
    my ($self, $c) = @_;
    my $page = $c->req->param('page');
}

sub show :Path('/api/players') :Args(1) :Method('GET') {
    my ($self, $c, $id) = @_;
    my $u = $c->model('DB::Player')->find($id);
}

sub create :Local :Args(0) :Method('POST') {
    my ($self, $c) = @_;
    my $params = decode_json($c->request->body_data || '{}');
    my $name = $params->{name};
    my $token = $c->req->header('X-Token');
}

sub destroy :Path('/api/players') :Args(1) :Method('DELETE') {
    my ($self, $c, $id) = @_;
    unless ($c->check_user_roles('admin')) { return; }
}

sub search :Global :Args {
    my ($self, $c) = @_;
}

sub helper :Private {
    my ($self, $c) = @_;
}

sub end :ActionClass('RenderView') {}
`;

describe("Catalyst routes — paths, :Args and params", () => {
  const out = routes(CONTROLLER);

  it("resolves :Path / :Local / :Global against the controller namespace", () => {
    expect(out.map(sig)).toEqual([
      "null /admin/players -> index",
      "GET /api/players/{id} -> show",
      "POST /admin/players/create -> create",
      "DELETE /api/players/{id} -> destroy",
      "null /search -> search",
    ]);
  });

  it("binds :Args(n) to route params named from the @_ unpack", () => {
    const show = out.find((r) => r.handler === "show")!;
    expect(show.params).toEqual([{ name: "id", type: null, binding: "route" }]);
  });

  it("reads body/query/header access from the action body", () => {
    const create = out.find((r) => r.handler === "create")!;
    expect(create.params).toEqual([
      { name: "X-Token", type: null, binding: "header", inferred: true },
      { name: "name", type: null, binding: "body", inferred: true },
    ]);
    expect(out.find((r) => r.handler === "index")!.params).toEqual([{ name: "page", type: null, binding: "query", inferred: true }]);
  });

  it("does not emit :Private helpers or the RenderView end action", () => {
    expect(out.some((r) => r.handler === "helper" || r.handler === "end" || r.handler === "auto")).toBe(false);
  });
});

describe("Catalyst routes — guards", () => {
  const out = routes(CONTROLLER);

  it("inherits the `auto :Private` checks on every action", () => {
    const index = out.find((r) => r.handler === "index")!;
    expect(index.auth).toEqual({
      policies: ["user_exists", "redirect($c->uri_for('/auth/login'))"],
      roles: [],
      schemes: [],
      anonymous: false,
      inherited: true,
    });
    expect(index.middleware).toEqual(["$c->user_exists", "$c->redirect($c->uri_for('/auth/login'))"]);
  });

  it("adds an action's own role check with the roles it names", () => {
    const destroy = out.find((r) => r.handler === "destroy")!;
    expect(destroy.auth).toMatchObject({ roles: ["admin"], inherited: false });
    expect(destroy.middleware).toContain("$c->check_user_roles('admin')");
  });

  it("$c->authenticate in an action is the login, not a guard", () => {
    const out2 = routes(`
package MyApp::Controller::Auth;
sub login :Path('/login') :Args(0) :Method('POST') {
    my ($self, $c) = @_;
    if ($c->authenticate({ email => $c->req->params->{email} })) { }
}
`);
    expect(out2[0]!.auth).toBeUndefined();
    expect(out2[0]!.params).toEqual([{ name: "email", type: null, binding: "query", inferred: true }]);
  });
});

describe("Catalyst chained actions", () => {
  it("resolves a same-file chain with its captures", () => {
    const out = routes(`
package MyApp::Controller::Cars;
sub base :Chained('/') :PathPart('cars') :CaptureArgs(1) {
    my ($self, $c, $car_id) = @_;
}
sub view :Chained('base') :PathPart('') :Args(0) :Method('GET') {
    my ($self, $c) = @_;
}
sub lines :Chained('base') :PathPart('lines') :Args(1) {
    my ($self, $c, $line_no) = @_;
}
`);
    expect(out.map(sig)).toEqual(["GET /cars/{car_id} -> view", "null /cars/{car_id}/lines/{line_no} -> lines"]);
    expect(out[1]!.params).toEqual([
      { name: "car_id", type: null, binding: "route" },
      { name: "line_no", type: null, binding: "route" },
    ]);
  });
});

describe("extractCatalystRequestAccess", () => {
  it("follows a variable bound to body_parameters", () => {
    expect(extractCatalystRequestAccess(lines(`
      my $p = $c->request->body_parameters;
      my $q = $c->req->query_parameters->{q};
      $p->{email}; $p->{name};
      my $f = $c->req->upload('avatar');
    `))).toEqual([
      { name: "q", type: null, binding: "query" },
      { name: "avatar", type: null, binding: "form" },
      { name: "email", type: null, binding: "body" },
      { name: "name", type: null, binding: "body" },
    ]);
  });

  it("types the body by the Moose class it is constructed into", () => {
    expect(extractCatalystRequestAccess(lines(`
      my $params = decode_json($c->req->body_data);
      my $input = My::Form::PlayerInput->new(%$params);
    `))).toEqual([{ name: "body", type: "My::Form::PlayerInput", binding: "body" }]);
  });

  it("reports the body itself when no key is named", () => {
    expect(extractCatalystRequestAccess(["  my $raw = $c->req->body_data;"])).toEqual([{ name: "body", type: null, binding: "body" }]);
  });
});

describe("perl parseParam", () => {
  it("drops the attribute paren of a Catalyst sub and keeps real signatures", () => {
    const fns = extractFunctionsWithSpec(lines(`sub index :Path('/players') :Args(0) {\n}\nsub add ($x, $y = 2) {\n}`), perlSpec);
    expect(fns.map((f) => [f.name, f.params.map((p) => p.name)])).toEqual([["index", []], ["add", ["x", "y"]]]);
  });
});

describe("Mojolicious / Dancer", () => {
  it("reads Mojolicious::Lite routes, `under` guards and $c reads", () => {
    const out = routes(`
use Mojolicious::Lite;
get '/ping' => sub { my $c = shift; $c->render(text => 'pong'); };
under sub {
    my $c = shift;
    return 1 if $c->session('user');
    $c->redirect_to('/login'); return 0;
};
get '/players/:id' => sub {
    my $c = shift;
    my $id = $c->stash('id');
    my $fmt = $c->param('format');
    $c->render(json => { id => $id });
};
post '/players' => sub { my $c = shift; my $data = $c->req->json; };
`);
    expect(out.map(sig)).toEqual(["GET /ping -> null", "GET /players/:id -> null", "POST /players -> null"]);
    expect(out[0]!.auth).toBeUndefined();
    expect(out[1]!.auth).toMatchObject({ inherited: true });
    expect(out[1]!.params).toEqual([
      { name: "format", type: null, binding: "query", inferred: true },
      { name: "id", type: null, binding: "route", inferred: true },
    ]);
    expect(out[2]!.params).toEqual([{ name: "body", type: null, binding: "body", inferred: true }]);
  });

  it("reads a full Mojolicious router with `->to` handlers and an `under` chain", () => {
    const out = routes(`
package MyApp;
use Mojo::Base 'Mojolicious';
sub startup {
    my $self = shift;
    my $r = $self->routes;
    $r->get('/')->to('pages#home');
    my $auth = $r->under('/admin')->to('auth#check');
    $auth->get('/players/:id')->to(controller => 'players', action => 'show');
}
`);
    expect(out.map(sig)).toEqual(["GET / -> Pages#home", "GET /players/:id -> Players#show"]);
    expect(out[1]!.auth).toEqual({ policies: ["Auth#check"], roles: [], schemes: [], anonymous: false, inherited: true });
    expect(out[0]!.auth).toBeUndefined();
  });

  it("reads Dancer2 routes with require_role wrappers and params", () => {
    const out = routes(`
use Dancer2;
use Dancer2::Plugin::Auth::Extensible;
get '/balls' => sub { my $q = query_parameters->get('q'); };
del '/balls/:id' => require_role admin => sub { my $id = route_parameters->get('id'); };
post '/balls' => require_login sub { my $name = body_parameters->get('name'); };
`);
    expect(out.map(sig)).toEqual(["GET /balls -> null", "DELETE /balls/:id -> null", "POST /balls -> null"]);
    expect(out[1]!.auth).toMatchObject({ roles: ["admin"], inherited: false });
    expect(out[1]!.params).toEqual([{ name: "id", type: null, binding: "route", inferred: true }]);
    expect(out[2]!.auth).toMatchObject({ policies: ["require_login"] });
    expect(out[2]!.params).toEqual([{ name: "name", type: null, binding: "body", inferred: true }]);
  });

  it("ignores the DSL shape in a file that uses neither framework", () => {
    expect(routes(`get '/x' => sub { 1 };`)).toEqual([]);
  });
});

describe("Moose attributes → request schema hooks", () => {
  it("reads multi-line `has` with isa + required", () => {
    const src = lines(`
package Form;
use Moose;
has name => (
    is       => 'ro',
    isa      => 'Str',
    required => 1,
);
has age => (is => 'ro', isa => 'Maybe[Int]');
has tags => (is => 'ro', isa => 'ArrayRef[Str]');
has _secret => (is => 'rw', isa => 'Bool');
`);
    const cls = perlSpec.extractClasses!(src, extractFunctionsWithSpec(src, perlSpec))[0]!;
    expect(cls.properties.map((p) => [p.name, p.type, p.isRequired ?? false])).toEqual([
      ["name", "Str", true],
      ["age", "Maybe[Int]", false],
      ["tags", "ArrayRef[Str]", false],
      ["_secret", "Bool", false],
    ]);
    expect(perlRequestSchema.isSerialized(cls.properties[3]!)).toBe(false);
    expect(perlRequestSchema.isRequired(cls.properties[0]!)).toBe(true);
  });

  it("maps type constraints to shapes", () => {
    expect(perlRequestSchema.unwrapNullable("Maybe[Int]")).toEqual({ type: "Int", nullable: true });
    expect(perlRequestSchema.describeType("Int")).toEqual({ kind: "scalar", schema: { type: "integer" } });
    expect(perlRequestSchema.describeType("ArrayRef[Str]")).toEqual({ kind: "array", element: "Str" });
    expect(perlRequestSchema.describeType("HashRef[Ball]")).toEqual({ kind: "map", value: "Ball" });
    expect(perlRequestSchema.describeType("My::App::Address")).toEqual({ kind: "object", name: "My::App::Address" });
    expect(perlRequestSchema.describeType("Any")).toEqual({ kind: "any" });
    expect(perlRequestSchema.bindParam!({ name: "c", type: null, defaultValue: null }, {} as RouteInfo)).toBe("services");
  });
});
