import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";

async function sourcesOf(body: string, lang: Language, header = ""): Promise<DataSourceInfo[]> {
  const ext = lang === "kotlin" ? "kt" : "java";
  const src =
    lang === "kotlin"
      ? `package x
${header}
class Repo {
  fun m(id: Int) {
${body}
  }
}`
      : `package x;
${header}
class Repo {
  void m(int id) {
${body}
  }
}`;
  const tree = await parseSource(src, lang as any, `Repo.${ext}`);
  return new JavaKotlinDataSourceExtractor().extract(tree, src);
}

/** Wrapper for jOOQ tests — the branch is gated on file-level jOOQ evidence
 *  (real query files always import org.jooq or the generated-tables package). */
const jooqSourcesOf = (body: string, lang: Language) =>
  sourcesOf(body, lang, lang === "kotlin" ? "import org.jooq.impl.DSL" : "import org.jooq.impl.DSL;");

const db = (s: DataSourceInfo[]) => s.filter((d) => d.kind === "database");

describe("Kotlin jOOQ data-source extraction (was completely blind before)", () => {
  it("captures the table from a `.from(CONSTANT)` chain → entity", async () => {
    const s = db(
      await jooqSourcesOf(
        `    val r = dsl.select(field("x")).from(STUDENT).where(field("id").eq(id)).fetch()`,
        "kotlin",
      ),
    );
    expect(s.some((d) => d.entity === "STUDENT" && d.target === "STUDENT")).toBe(true);
  });

  it("captures `selectFrom(table(\"sps.Module\"))` and strips the schema prefix", async () => {
    const s = db(await jooqSourcesOf(`    val r = dsl.selectFrom(table("sps.Module")).fetch()`, "kotlin"));
    expect(s.some((d) => d.entity === "Module")).toBe(true);
  });

  it("captures `insertInto(Tables.MODULESETTING)` (qualified constant → last segment)", async () => {
    const s = db(await jooqSourcesOf(`    dsl.insertInto(Tables.MODULESETTING).set(x, y).execute()`, "kotlin"));
    expect(s.some((d) => d.entity === "MODULESETTING" && d.name === "jOOQ: insertInto")).toBe(true);
  });

  it("does NOT treat lowercase-local `update(student)` as a jOOQ table touch", async () => {
    const s = db(await sourcesOf(`    service.update(student)`, "kotlin"));
    expect(s.some((d) => d.name.startsWith("jOOQ:"))).toBe(false);
  });

  it("does NOT treat `LocalDate.from(value)` as a jOOQ table touch", async () => {
    const s = db(await jooqSourcesOf(`    val d = LocalDate.from(value)`, "kotlin"));
    expect(s.length).toBe(0);
  });

  it("resolves a file-local `val TABLE = DSL.table(\"X\")` alias to the real table", async () => {
    // Class-level alias binding + a method that queries it.
    const src = `package x
import org.jooq.impl.DSL
class Dao {
  private val TABLE = DSL.table("CaseExternalSupportUser")
  fun load(id: Int) {
    val r = dsl.select(field("id")).from(TABLE).fetch()
  }
}`;
    const tree = await parseSource(src, "kotlin" as any, "Dao.kt");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.entity === "CaseExternalSupportUser")).toBe(true);
    expect(s.some((d) => d.entity === "TABLE")).toBe(false);
  });

  it("resolves an inline `.from(GRANTITEM.as(\"gi\"))` alias to the table", async () => {
    const s = db(await jooqSourcesOf(`    val r = dsl.select().from(GRANTITEM.as("gi")).fetch()`, "kotlin"));
    expect(s.some((d) => d.entity === "GRANTITEM")).toBe(true);
  });
});

describe("DAO / Repository receiver → entity (the dominant data path here)", () => {
  it("derives the entity from a `<entity>DAO.<crud>()` call", async () => {
    const s = db(await sourcesOf(
      `    val d = documentDAO.get(id); documentDAO.update(d); val c = caseDAO.findByStudent(x)`,
      "kotlin",
    ));
    expect(s.some((d) => d.entity === "document" && d.name === "DAO: get")).toBe(true);
    expect(s.some((d) => d.entity === "document" && d.name === "DAO: update")).toBe(true);
    expect(s.some((d) => d.entity === "case")).toBe(true);
  });

  it("handles a `this.userRepository.save()` receiver", async () => {
    const s = db(await sourcesOf(`    this.userRepository.save(u)`, "kotlin"));
    expect(s.some((d) => d.entity === "user")).toBe(true);
  });

  it("does NOT treat a non-CRUD method on a DAO, or a DAO factory, as access", async () => {
    const s = db(await sourcesOf(`    caseDAO.toString(); val dao = CaseDAOFactory.getInstance()`, "kotlin"));
    expect(s.length).toBe(0);
  });
});

describe("Java jOOQ + Spring Data", () => {
  it("captures jOOQ table on the Java AST too", async () => {
    const s = db(await jooqSourcesOf(`    var r = dsl.deleteFrom(REIMBURSEMENT).where(c).execute();`, "java"));
    expect(s.some((d) => d.entity === "REIMBURSEMENT" && d.name === "jOOQ: deleteFrom")).toBe(true);
  });

  it("still recognises Spring Data repository methods (Kotlin too)", async () => {
    const kt = db(await sourcesOf(`    repo.findByEmail("a"); repo.save(x); repo.deleteById(id)`, "kotlin"));
    expect(kt.map((d) => d.name).sort()).toEqual(["deleteById", "findByEmail", "save"]);
  });

  it("does NOT flag `file.delete()` or a plain getter as DB access", async () => {
    const s = db(await sourcesOf(`    file.delete(); var n = user.getName();`, "java"));
    expect(s.length).toBe(0);
  });
});

describe("jOOQ false-table fences", () => {
  it("String.join(ALL_CAPS_CONST, …) in a non-jOOQ file emits nothing (file gate)", async () => {
    const s = db(await sourcesOf(
      `    String k = String.join(CONFIGURATION_NAME_DELIMITER, parts);`,
      "java",
    ));
    expect(s.length).toBe(0);
  });

  it("String.join(ALL_CAPS_CONST, …) inside a jOOQ file emits nothing (class-shaped receiver veto)", async () => {
    const s = db(await jooqSourcesOf(
      `    String k = String.join(CONFIGURATION_NAME_DELIMITER, parts);`,
      "java",
    ));
    expect(s.length).toBe(0);
  });
});

describe("Repository receiver → entity via declared field type", () => {
  it("resolves the entity from the field's TYPE, not the field name", async () => {
    // The field name says externalId; the type says FederatedIdentity — the
    // type is what names the entity.
    const src = `package x;
class RoleOverviewApiService {
  private final FederatedIdentityJpaRepository externalIdJpaRepository;
  void m(String customerId) {
    externalIdJpaRepository.findIdsByCustomerId(customerId);
  }
}`;
    const tree = await parseSource(src, "java" as any, "RoleOverviewApiService.java");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.entity === "FederatedIdentity")).toBe(true);
  });

  it("strips a residual Jpa/Db tech suffix from the receiver name", async () => {
    const s = db(await sourcesOf(`    accountJpaRepository.findById(id);`, "java"));
    expect(s.some((d) => d.entity === "account")).toBe(true);
  });

  it("strips the interface-convention I prefix from a DAO type", async () => {
    const src = `package x
class Service(private val caseDAO: ICaseDAO) {
  fun m(id: Int) {
    caseDAO.get(id)
  }
}`;
    const tree = await parseSource(src, "kotlin" as any, "Service.kt");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.entity === "Case")).toBe(true);
  });
});

describe("Repository-PREFIX naming (`RepositoryClass repositoryClass`)", () => {
  it("derives the entity from a prefix-named repository type", async () => {
    const src = `package x;
class ServiceTeacherImpl {
  private final RepositoryClass repositoryClass;
  void m(int id) {
    repositoryClass.findByOrganizationIdAndIsDeletedFalse(id);
    repositoryClass.save(c);
  }
}`;
    const tree = await parseSource(src, "java" as any, "ServiceTeacherImpl.java");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s).toHaveLength(2);
    expect(s.every((d) => d.entity === "Class" && d.target === "Class")).toBe(true);
  });

  it("derives the entity from a prefix-named field with no declared type", async () => {
    const s = db(await sourcesOf(`    daoInvoice.findById(id);`, "java"));
    expect(s.some((d) => d.entity === "Invoice")).toBe(true);
  });

  it("vetoes a prefix base naming a collaborator role, and bare `repo…`", async () => {
    const s = db(await sourcesOf(`    daoFactory.create(x); repoPath.getParent();`, "java"));
    expect(s).toHaveLength(0);
  });
});

describe("Spring Data call on a non-DAO-shaped receiver", () => {
  it("targets the receiver's declared type rather than leaving it unresolved", async () => {
    const src = `package x;
class S {
  private final UserStore store;
  void m(String e) { store.findByEmail(e); }
}`;
    const tree = await parseSource(src, "java" as any, "S.java");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.map((d) => d.target)).toEqual(["UserStore"]);
  });

  it("does not make a service-layer receiver type a datastore", async () => {
    const src = `package x;
class UserController {
  private final UserService userService;
  void m() { userService.findAll(); }
}`;
    const tree = await parseSource(src, "java" as any, "UserController.java");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    // A call into the service layer is no access of its own — the service's
    // method shows the access where it happens.
    expect(s).toEqual([]);
  });

  it("stays unresolved when the receiver has no declared type", async () => {
    const s = db(await sourcesOf(`    lookup().findByEmail(e);`, "java"));
    expect(s.map((d) => d.target)).toEqual([null]);
  });
});

describe("Typed application/domain events", () => {
  const q = (s: DataSourceInfo[]) =>
    s.filter((d) => d.kind === "queue-publish" || d.kind === "queue-consume");

  it("@MessageHandler handler → queue-consume on the first parameter's type", async () => {
    const src = `package x;
public class OrganisationEventHandler {
  @MessageHandler(threadSafe = true)
  public void handle(ElementUpdatedEvent event, Metadata metadata) {
    updateRoles(event.getSubject());
  }
}`;
    const tree = await parseSource(src, "java" as any, "OrganisationEventHandler.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.kind === "queue-consume" && d.target === "ElementUpdatedEvent" && d.name === "@MessageHandler")).toBe(true);
  });

  it("@EventListener(X.class) → queue-consume on the annotation's class", async () => {
    const src = `package x;
public class Refresher {
  @EventListener(SourceIngestedEvent.class)
  public void onIngest(Object anything) {}
}`;
    const tree = await parseSource(src, "java" as any, "Refresher.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.kind === "queue-consume" && d.target === "SourceIngestedEvent")).toBe(true);
  });

  it("publisher.send(audit, meta, message) → queue-publish on the local's declared type", async () => {
    const src = `package x;
public class AccountEventServiceImpl {
  private final EventPublisher eventPublisher;
  void notifyUpdate(String id) {
    AuditInformation auditInformation = createAuditInformation();
    Metadata metaData = createMetadata(id);
    AccountUpdateMessage message = AccountUpdateMessage.newBuilder().setId(id).build();
    eventPublisher.send(auditInformation, metaData, message);
  }
}`;
    const tree = await parseSource(src, "java" as any, "AccountEventServiceImpl.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.kind === "queue-publish" && d.target === "AccountUpdateMessage")).toBe(true);
  });

  it("publishEvent(new X(...)) → queue-publish even without an Event suffix requirement", async () => {
    const s = q(await sourcesOf(`    springPublisher.publishEvent(new SourceIngested(serviceName));`, "java"));
    expect(s.some((d) => d.kind === "queue-publish" && d.target === "SourceIngested")).toBe(true);
  });

  it("does NOT read a non-event payload on a generic sender as an event", async () => {
    const s = q(await sourcesOf(`    emailPublisher.send(new Attachment(file));`, "java"));
    expect(s.length).toBe(0);
  });

  it("prefers the event-shaped parameter over audit/metadata companions", async () => {
    const src = `package x;
public class LoginEventHandler {
  @MessageHandler(threadSafe = true)
  public void handle(AuditInformation auditInformation, Metadata metadata, LoginMessage msg) {}
}`;
    const tree = await parseSource(src, "java" as any, "LoginEventHandler.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.kind === "queue-consume" && d.target === "LoginMessage")).toBe(true);
  });

  it("strips an upper-case DB tech suffix from a repository type", async () => {
    const src = `package x;
class CustomerService {
  private final CustomerDBRepository customerDb;
  void m(String id) { customerDb.findById(id); }
}`;
    const tree = await parseSource(src, "java" as any, "CustomerService.java");
    const s = new JavaKotlinDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
    expect(s.some((d) => d.entity === "Customer")).toBe(true);
  });
});

describe("extension clients keyed by the entity class (Halo)", () => {
  it("reads the class literal, else the declared type of the object handed over", async () => {
    const java = `import run.halo.app.extension.ReactiveExtensionClient;
class PostServiceImpl {
  private final ReactiveExtensionClient client;
  Mono<Post> getPost(String name) { return client.fetch(Post.class, name); }
  Flux<Post> list() { return client.listAll(Post.class, options, sort); }
  Mono<Post> save(Post post) { return client.update(post); }
  Mono<Void> remove(String name, ExtensionClient other) { return client.delete(something); }
}`;
    const tree = await parseSource(java, "java", "PostServiceImpl.java");
    const rows = new JavaKotlinDataSourceExtractor().extract(tree, java).filter((d) => d.kind === "database");
    expect(rows.map((d) => `${d.name} ${d.entity ?? "-"} ${d.access}`)).toEqual([
      "client.fetch Post read",
      "client.listAll Post read",
      "client.update Post write",
      "client.delete - write",
    ]);
  });
});

describe("Java JPA / Hibernate rows name their entity", () => {
  const db = (rows: DataSourceInfo[]) => rows.filter((r) => r.kind === "database").map((r) => [r.name, r.entity ?? null]);

  it("takes the entity from an instance argument's declared type, Optional unwrapped", async () => {
    const rows = await sourcesOf(`
    PersonAddress address = new PersonAddress();
    Optional<Person> person = Optional.empty();
    em.persist(address);
    em.merge(person.get());
    session.saveOrUpdate(address);
    session.get(Order.class, id);
    for (Category c : categories) { em.remove(c); }`, "java");
    expect(db(rows)).toEqual([
      ["persist", "PersonAddress"],
      ["merge", "Person"],
      ["saveOrUpdate", "PersonAddress"],
      ["get", "Order"],
      ["remove", "Category"],
    ]);
  });

  it("counts a query chain once, on the query it builds", async () => {
    const rows = await sourcesOf(`em.createNamedQuery("q", Unit.class).setParameter("a", id).getResultList();`, "java");
    expect(db(rows)).toEqual([["createNamedQuery", "Unit"]]);
  });

  it("is not fooled by services, REST templates and HTTP sessions", async () => {
    const rows = await sourcesOf(`
    elementTemplateService.merge(template);
    restTemplate.delete("/x");
    request.getSession().get("k");
    EntityManager entityManager = null;
    entityManager.find(Person.class, id);
    personCacheQueryService.findByHypernetId(id);`, "java");
    // An EntityManager stays a handle although its type ends in "Manager".
    expect(db(rows)).toEqual([["find", "Person"]]);
  });
});
