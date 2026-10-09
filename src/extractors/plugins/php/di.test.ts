import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { ensureLanguagesLoaded } from "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractCalls } from "../../shared/call-graph.js";
import { PhpExtractor } from "./functions-classes.js";
import { phpDiBindings } from "./di.js";
import type { ClassInfo, DiBinding } from "../../../types/analysis.js";

async function tree(src: string) {
  await ensureLanguagesLoaded(["php"]);
  return parseSource(src, "php" as any, "x.php");
}

async function bindings(src: string): Promise<Array<Partial<DiBinding>>> {
  return phpDiBindings(await tree(src), src).map(({ line: _l, via: _v, ...rest }) => rest);
}

async function classes(src: string): Promise<ClassInfo[]> {
  const t = await tree(src);
  return new PhpExtractor().extractClasses(t, src);
}

describe("PHP container registrations", () => {
  it("reads Laravel bind/singleton/instance, closures, and the *If defaults", async () => {
    expect(await bindings(`<?php
use App\\Repo\\SqlUserRepository as SqlRepo;
class AppServiceProvider extends ServiceProvider {
  public function register(): void {
    $this->app->bind(UserRepositoryInterface::class, SqlRepo::class);
    $this->app->singleton(\\App\\Contracts\\Mailer::class, fn ($app) => new SmtpMailer($app['config']));
    $this->app->scoped(Clock::class, function ($app) { return new SystemClock(); });
    $this->app->instance(Cache::class, new RedisCache());
    $this->app->bindIf(Notifier::class, MailNotifier::class);
    App::bind('payments', StripeGateway::class);
    app()->singleton(Queue::class, SqsQueue::class);
  }
}`)).toEqual([
      { service: "UserRepositoryInterface", implementation: "SqlUserRepository" },
      { service: "Mailer", implementation: "SmtpMailer" },
      { service: "Clock", implementation: "SystemClock" },
      { service: "Cache", implementation: "RedisCache" },
      { service: "Notifier", implementation: "MailNotifier", ifAbsent: true },
      { service: "payments", implementation: "StripeGateway" },
      { service: "Queue", implementation: "SqsQueue" },
    ]);
  });

  it("reads provider arrays, contextual bindings and aliases", async () => {
    expect(await bindings(`<?php
class P extends ServiceProvider {
  public $bindings = [Reporter::class => PdfReporter::class];
  public $singletons = ['geo' => GeoIp::class];
  public function register() {
    $this->app->when([OrderController::class, Billing::class])->needs(Notifier::class)->give(SmsNotifier::class);
    $this->app->when(Audit::class)->needs(Logger::class)->give(fn () => new FileLogger('/tmp/x'));
    $this->app->alias(Mailer::class, 'mailer');
  }
}`)).toEqual([
      { service: "Reporter", implementation: "PdfReporter" },
      { service: "geo", implementation: "GeoIp" },
      { service: "Notifier", implementation: "SmsNotifier", consumer: "OrderController" },
      { service: "Notifier", implementation: "SmsNotifier", consumer: "Billing" },
      { service: "Logger", implementation: "FileLogger", consumer: "Audit" },
      { service: "mailer", implementation: "Mailer" },
    ]);
  });

  it("reads Symfony services config, ContainerBuilder and attributes", async () => {
    expect(await bindings(`<?php
return function (ContainerConfigurator $c) {
  $services = $c->services();
  $services->set(UserRepositoryInterface::class, DoctrineUserRepository::class);
  $services->alias(Clock::class, SystemClock::class);
  $container->setAlias(Mailer::class, SmtpMailer::class);
};
#[AsAlias(id: Notifier::class)]
class MailNotifier implements Notifier {}
#[AsAlias]
class SqlCache implements CacheInterface {}
#[Bind(StripeGateway::class)]
interface PaymentGateway {}`)).toEqual([
      { service: "UserRepositoryInterface", implementation: "DoctrineUserRepository" },
      { service: "Clock", implementation: "SystemClock" },
      { service: "Mailer", implementation: "SmtpMailer" },
      { service: "Notifier", implementation: "MailNotifier" },
      { service: "CacheInterface", implementation: "SqlCache" },
      { service: "PaymentGateway", implementation: "StripeGateway" },
    ]);
  });

  it("reads PHP-DI definitions only in a file that uses PHP-DI", async () => {
    expect(await bindings(`<?php
use function DI\\autowire;
return [
  UserRepository::class => autowire(SqlUserRepository::class),
  Mailer::class => \\DI\\create(SmtpMailer::class),
  Clock::class => DI\\factory(fn () => new SystemClock()),
  Cache::class => autowire(),
];`)).toEqual([
      { service: "UserRepository", implementation: "SqlUserRepository" },
      { service: "Mailer", implementation: "SmtpMailer" },
      { service: "Clock", implementation: "SystemClock" },
    ]);
    expect(await bindings(`<?php $x = ['a' => create(Foo::class)];`)).toEqual([]);
  });

  it("does not mistake PDO's or a closure's bind for a registration", async () => {
    expect(await bindings(`<?php
function q($stmt, $id, $closure) {
  $stmt->bind(':id', $id);
  $stmt->bindValue(':id', $id);
  Closure::bind($closure, null, Foo::class);
  $this->app->bind(Foo::class, $someVariable);
}`)).toEqual([]);
  });
});

describe("PHP injection facts", () => {
  it("types untyped params, properties and locals from docblocks", async () => {
    const [cls] = await classes(`<?php
class Svc {
  /** @var \\App\\Repo\\UserRepository|null */
  private $repo;
  /**
   * @param Mailer $mailer the mailer
   * @param int $retries
   */
  public function __construct($mailer, $retries, Typed $native) {}
  public function run() {
    /** @var Report $r */
    $r = $this->build();
    /** @var Exporter */
    $e = $this->exporter();
  }
}`);
    expect(cls!.properties.find((p) => p.name === "repo")!.type).toBe("UserRepository|null");
    const ctor = cls!.methods.find((m) => m.name === "__construct")!;
    expect(ctor.params.map((p) => [p.name, p.type])).toEqual([["mailer", "Mailer"], ["retries", "int"], ["native", "Typed"]]);
    expect(cls!.methods.find((m) => m.name === "run")!.localTypes).toEqual([
      { name: "r", type: "Report" },
      { name: "e", type: "Exporter" },
    ]);
  });

  it("keeps every initializer call of a local the body never types", async () => {
    const [cls] = await classes(`<?php
class Svc {
  public function run($group) {
    $journal = $group->journals->first();
    $writer = IOFactory::createWriter($book);
    if (!$journal) { $journal = new Journal(); }
    if ($rich) { $text = $v->createText(); } else { $text = $v->createTextRun(); }
  }
}`);
    expect(cls!.methods[0]!.localTypes).toEqual([
      { name: "journal", type: "Journal" },
      { name: "writer", type: "", from: "IOFactory.createWriter()" },
      // One per branch: the linker types `$text` only if both return the same class.
      { name: "text", type: "", from: "v.createText()" },
      { name: "text", type: "", from: "v.createTextRun()" },
    ]);
  });

  it("records a class's trait uses beside the interfaces it implements", async () => {
    const [cls] = await classes(`<?php
class User extends Model implements Auth {
  use \\App\\Concerns\\HasRoles, Notifiable;
  use Sorts { sort as order; }
}`);
    expect([cls!.extends, cls!.implements]).toEqual(["Model", ["Auth", "HasRoles", "Notifiable", "Sorts"]]);
  });

  it("reads a method's return type from `@return` when it declares none", async () => {
    const [cls] = await classes(`<?php
class Sheet {
  /**
   * @param string $v
   * @return \\PHPExcel\\Worksheet
   */
  public function getActiveSheet($v) {}
  /** @return $this */
  public function setTitle($t) {}
  /** @return Other|false */
  public function getCell($c): ?Cell {}
  public function plain() {}
}`);
    expect(cls!.methods.map((m) => [m.name, m.returnType])).toEqual([
      ["getActiveSheet", "Worksheet"],
      ["setTitle", "$this"],
      ["getCell", "Cell"],
      ["plain", null],
    ]);
  });

  it("types properties the constructor fills, and object-typed class @property tags", async () => {
    const [cls] = await classes(`<?php
/**
 * @property Users_model $users_model
 * @property int $id
 */
class Svc {
  private $repo;
  public function __construct(UserRepository $repository, $untyped) {
    $this->repo = $repository;
    $this->clock = new SystemClock();
    $this->mailer = app(Mailer::class);
    $this->geo = app('geo');
    $this->other = $untyped;
  }
}`);
    const byName = Object.fromEntries(cls!.properties.map((p) => [p.name, [p.type, p.qualifier]]));
    expect(byName).toEqual({
      repo: ["UserRepository", undefined],
      clock: ["SystemClock", undefined],
      mailer: ["Mailer", undefined],
      geo: [null, "geo"],
      users_model: ["Users_model", undefined],
    });
  });

  it("records locals bound by container lookups, and Symfony target qualifiers", async () => {
    const [cls] = await classes(`<?php
class Svc {
  public function __construct(#[Target('fastCache')] CacheInterface $cache, #[Autowire(service: 'app.mailer')] $mailer) {}
  public function run(Request $request) {
    $a = app(Foo::class);
    $b = $this->app->make(Bar::class);
    $c = App::make(Baz::class);
    $d = $this->container->get(Qux::class);
    $e = resolve('payments');
    $f = $request->get('email');
  }
}`);
    const ctor = cls!.methods.find((m) => m.name === "__construct")!;
    expect(ctor.params.map((p) => p.qualifier)).toEqual(["fastCache", "app.mailer"]);
    expect(cls!.methods.find((m) => m.name === "run")!.localTypes).toEqual([
      { name: "a", type: "Foo" },
      { name: "b", type: "Bar" },
      { name: "c", type: "Baz" },
      { name: "d", type: "Qux" },
      { name: "e", type: "", qualifier: "payments" },
      // A call that states no type: typed by what it is declared to return.
      { name: "f", type: "", from: "request.get()" },
    ]);
  });

  // (PHP's call extraction records member and static calls only — bare
  // function calls and `new X` are not calls in its output.)
  it("gives an inline lookup's call its receiver type, and keeps nullsafe calls", async () => {
    const t = await tree(`<?php function f($x) {
  app(Mailer::class)->send('hi');
  (new Report())->render();
  $x?->notify();
}`);
    const body = t.rootNode.descendantsOfType("compound_statement")[0]!;
    const calls = extractCalls(body, "php");
    expect(calls.map((c) => [c.name, c.receiverType ?? null])).toEqual([
      ["app(Mailer::class).send", "Mailer"],
      ["(new Report()).render", "Report"],
      ["x.notify", null],
    ]);
  });
});

describe("PHP closures", () => {
  // The scope sets are per language: a PHP closure's calls were attributed to
  // its method only when the JS plugin (which shares the `arrow_function` node
  // name) happened to be loaded — different in a worker than in-process.
  it("attributes the calls of closures passed along to the enclosing method", async () => {
    const [cls] = await classes(`<?php
class Svc {
  public function run($users) {
    return $users->map(fn ($u) => $this->repo->load($u))
      ->each(function ($u) { $this->notifier->notify($u); });
  }
}`);
    const names = cls!.methods[0]!.calls.map((c) => c.name);
    expect(names).toContain("this.repo.load");
    expect(names).toContain("this.notifier.notify");
  });
});

describe("PHP method injection", () => {
  it("marks controller actions' and handle()/__invoke() parameters as container-injected", async () => {
    const all = await classes(`<?php
class UserController extends Controller {
  public function __construct(Mailer $m) {}
  public function show(UserService $svc, int $id) {}
  private function helper(UserService $svc) {}
}
class SendReport { public function handle(Reporter $r) {} }
class Plain { public function run(Reporter $r) {} }`);
    const injected = (cls: string, m: string) =>
      all.find((c) => c.name === cls)!.methods.find((x) => x.name === m)!.params.map((p) => [p.name, !!p.injected]);
    expect(injected("UserController", "__construct")).toEqual([["m", false]]);
    expect(injected("UserController", "show")).toEqual([["svc", true], ["id", true]]);
    expect(injected("UserController", "helper")).toEqual([["svc", false]]);
    expect(injected("SendReport", "handle")).toEqual([["r", true]]);
    expect(injected("Plain", "run")).toEqual([["r", false]]);
  });
});
