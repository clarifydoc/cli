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
  private val TABLE = DSL.table("CaseExternalSupportPlayer")
  fun load(id: Int) {
    val r = dsl.select(field("id")).from(TABLE).fetch()
  }
}`;
    const tree = await parseSource(src, "kotlin" as any, "Dao.kt");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.entity === "CaseExternalSupportPlayer")).toBe(true);
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

  it("takes a generic DAO's entity from the class literal or the instance it is handed, never from its name (real-repo FP)", async () => {
    const s = db(await sourcesOf(
      `    Player p = new Player(); commonDAO.save(p); commonDAO.find(Club.class, id); commonDAO.flush(); matchDAO.find(Season.class, id);`,
      "java",
    ));
    expect(s.map((d) => `${d.name} ${d.entity ?? "-"}`)).toEqual(["DAO: save Player", "DAO: find Club", "DAO: find Season"]);
  });

  it("reads the entity of a JPQL query handed to a constructor", async () => {
    const s = db(await sourcesOf(
      `    var d = new EntityListDescriptor<>(Match.class, "select m from Match m " + "where m.season = :s");
    var n = new Notice("select a seat from the list");`,
      "java",
    ));
    expect(s.map((d) => `${d.name} ${d.entity} ${d.access}`)).toEqual(["new EntityListDescriptor Match read"]);
  });

  it("reads a query held in a constant, on a handle declared as one whatever its name", async () => {
    const s = db(await sourcesOf(
      `    session.createSQLQuery(EXISTS).uniqueResult();
    template.execute(INSERT_SEASON);`,
      "java",
      `class Holder {
  private static final String EXISTS = "SELECT 1 FROM league.fixtures " + "WHERE id = ?";
  private static final String INSERT_SEASON = """
      INSERT INTO seasons (id) VALUES (?)
      """;
  private JdbcTemplate template;
}`,
    ));
    expect(s.map((d) => `${d.name} ${d.entity ?? "-"} ${d.access ?? "-"}`)).toEqual(["createSQLQuery fixtures read", "execute seasons write"]);
  });

  it("folds a table constant into the SQL concatenated around it, in a call and in a constructor-set field", async () => {
    const s = db(await sourcesOf(
      `    em.createNativeQuery("INSERT INTO " + TABLE + " (club_id, scored_at) VALUES (?1, ?2)").executeUpdate();
    jdbcTemplate.update(sqlInsert, id);
    jdbcTemplate.queryForList(SELECT_ALL);`,
      "java",
      `class Outbox {
  private static final String TABLE = "league_goal_log";
  private static final String SELECT_ALL = "SELECT * FROM " + Outbox.OUTBOX;
  private static final String OUTBOX = "league_outbox";
  private final String sqlInsert;
  private JdbcTemplate jdbcTemplate;
  Outbox(String owner, boolean auto) {
    sqlInsert = auto ? "INSERT INTO " + owner + OUTBOX + " (exchange) VALUES (?)" : "INSERT INTO " + owner + OUTBOX + " (id, exchange) VALUES (?, ?)";
  }
}`,
    ));
    expect(s.map((d) => `${d.name} ${d.entity ?? "-"} ${d.access ?? "-"}`)).toEqual([
      "createNativeQuery league_goal_log write",
      "update league_outbox write",
      "queryForList league_outbox read",
    ]);
  });

  it("reads a query held in a local text block, and the entity a TypedQuery's type states", async () => {
    const s = db(await sourcesOf(
      `    String sql = """
        SELECT group_id FROM club_group WHERE x = ?
        """;
    em.createNativeQuery(sql).getResultList();
    TypedQuery<PlayerEntity> query = em.createQuery(criteria);`,
      "java",
    ));
    expect(s.map((d) => `${d.name} ${d.entity ?? "-"}`)).toEqual(["createNativeQuery club_group", "createQuery PlayerEntity"]);
  });

  it("handles a `this.playerRepository.save()` receiver", async () => {
    const s = db(await sourcesOf(`    this.playerRepository.save(u)`, "kotlin"));
    expect(s.some((d) => d.entity === "player")).toBe(true);
  });

  it("does NOT treat a non-CRUD method on a DAO, or a DAO factory, as access", async () => {
    const s = db(await sourcesOf(`    caseDAO.toString(); val dao = CaseDAOFactory.getInstance()`, "kotlin"));
    expect(s.length).toBe(0);
  });
});

describe("CXF WebClient requests", () => {
  it("sends to the client's base and the paths set on it, never a database read", async () => {
    const rows = await sourcesOf(`    WebClient client = clientFactory.createWebClient(leagueUrl, context);
    client.path("clubs/" + clubId + "/squad/");
    client.query("season", season);
    Squad squad = client.get(Squad.class);
    WebClient.create("http://fixtures:8080/api").path("matches").path(matchId).post(report);
    client.replacePath("kits");
    client.invoke("PATCH", kit);`, "java", "import org.apache.cxf.jaxrs.client.WebClient;");
    expect(rows.filter((d) => d.kind === "api-call" || d.kind === "database").map((d) => `${d.kind} ${d.name} ${d.target}`)).toEqual([
      "api-call GET ${leagueUrl}/clubs/${clubId}/squad",
      "api-call POST http://fixtures:8080/api/matches/${matchId}",
      "api-call PATCH ${leagueUrl}/kits",
    ]);
  });
});

describe("QueryDSL queries", () => {
  it("reads the entity each generated Q path names, by static import, inline or declared type", async () => {
    const rows = db(await sourcesOf(`    JPAQuery<PlayerEntity> query = queryFactory.selectFrom(playerEntity);
    QClubEntity c = QClubEntity.clubEntity;
    queryFactory.select(c.id.count(), playerEntity.id.count()).from(c).leftJoin(QKitEntity.kitEntity).fetch();
    queryFactory.delete(playerEntity).where(playerEntity.retired.isTrue()).execute();
    stream.from(source);`, "java", `import static com.example.league.QPlayerEntity.playerEntity;
import com.querydsl.jpa.impl.JPAQuery;`));
    expect(rows.map((d) => `${d.name} ${d.entity} ${d.access}`)).toEqual([
      "QueryDSL: selectFrom PlayerEntity read",
      "QueryDSL: leftJoin KitEntity read",
      "QueryDSL: from ClubEntity read",
      "QueryDSL: delete PlayerEntity write",
    ]);
  });

  it("reads nothing in a file that does not use QueryDSL", async () => {
    const rows = db(await sourcesOf(`    flux.from(QPlayer.player);`, "java"));
    expect(rows).toEqual([]);
  });
});

describe("count and save that are no repository's", () => {
  it("skips a stream's count, a criteria count and an action's save; keeps a repository's", async () => {
    const rows = db(await sourcesOf(`    long n = players.stream().filter(p -> p.isFit()).count();
    cq.select(em.getCriteriaBuilder().count(root.get("id")));
    crit.setProjection(Projections.count("p.id"));
    signAction.save(requestContext);
    long all = playerRepository.count();`, "java", "import org.springframework.data.jpa.repository.JpaRepository;"));
    expect(rows.map((d) => `${d.name} @${d.line}`)).toEqual(["DAO: count @9"]);
  });
});

describe("SQL assembled around a table hole", () => {
  it("names no table from the keyword after the hole, and still reads a JPQL entity", async () => {
    const holed = await sourcesOf(`    jdbcTemplate.queryForList("SELECT " + projection + " FROM " + spec.table + " WHERE " + spec.scopeWhere, params);`, "java");
    expect(db(holed).map((d) => d.entity ?? "-")).not.toContain("WHERE");
    const jpql = await sourcesOf(`    em.createQuery("SELECT o FROM Order o WHERE o.club = :club").getResultList();`, "java");
    expect(db(jpql).map((d) => d.entity)).toContain("Order");
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
    const s = db(await sourcesOf(`    file.delete(); var n = player.getName();`, "java"));
    expect(s.length).toBe(0);
  });
});

describe("jOOQ `delete(TABLE)` — the older spelling of deleteFrom", () => {
  it("names the table of a delete chained on a DSL context (Kotlin)", async () => {
    const s = db(await jooqSourcesOf(`    JooqFactory.getDSL().delete(MATCHREPORT).where(MATCHREPORT.ID.eq(id)).execute()
    dsl
      .delete(Tables.FIXTURE)
      .execute()`, "kotlin"));
    expect(s.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["jOOQ: delete", "MATCHREPORT", "write"],
      ["jOOQ: delete", "FIXTURE", "write"],
    ]);
  });

  it("names the table in Java, through a file-local table alias", async () => {
    const s = db(await sourcesOf(`    ctx.delete(TABLE).where(CLUB.ID.eq(id)).execute();`, "java",
      "import org.jooq.impl.DSL;\nclass T { static final Table<?> TABLE = DSL.table(\"league.Club\"); }"));
    expect(s.some((d) => d.name === "jOOQ: delete" && d.entity === "Club")).toBe(true);
  });

  it("leaves a cache or DAO delete alone, even in a jOOQ file", async () => {
    const s = db(await jooqSourcesOf(`    cache.delete(SQUAD_KEY)
    playerCache.delete(PLAYER)`, "kotlin"));
    expect(s.some((d) => d.name === "jOOQ: delete")).toBe(false);
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
  void m(String driverId) {
    externalIdJpaRepository.findIdsByDriverId(driverId);
  }
}`;
    const tree = await parseSource(src, "java" as any, "RoleOverviewApiService.java");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.entity === "FederatedIdentity")).toBe(true);
  });

  it("strips a residual Jpa/Db tech suffix from the receiver name", async () => {
    const s = db(await sourcesOf(`    clubJpaRepository.findById(id);`, "java"));
    expect(s.some((d) => d.entity === "club")).toBe(true);
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
    const s = db(await sourcesOf(`    daoBill.findById(id);`, "java"));
    expect(s.some((d) => d.entity === "Bill")).toBe(true);
  });

  it("vetoes a prefix base naming a collaborator role, and bare `repo…`", async () => {
    const s = db(await sourcesOf(`    daoFactory.create(x); repoPath.getParent();`, "java"));
    expect(s).toHaveLength(0);
  });

  it("does not take a Maven resolver's RepositorySystem for a repository (real-repo FP)", async () => {
    const s = db(await sourcesOf(`    repositorySystem.readArtifactDescriptor(session, request);`, "java"));
    expect(s).toHaveLength(0);
  });
});

describe("Spring Data call on a non-DAO-shaped receiver", () => {
  it("targets the receiver's declared type rather than leaving it unresolved", async () => {
    const src = `package x;
class S {
  private final PlayerStore store;
  void m(String e) { store.findByEmail(e); }
}`;
    const tree = await parseSource(src, "java" as any, "S.java");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.map((d) => d.target)).toEqual(["PlayerStore"]);
  });

  it("does not make a service-layer receiver type a datastore", async () => {
    const src = `package x;
class PlayerController {
  private final PlayerService playerService;
  void m() { playerService.findAll(); }
}`;
    const tree = await parseSource(src, "java" as any, "PlayerController.java");
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
public class ClubEventServiceImpl {
  private final EventPublisher eventPublisher;
  void notifyUpdate(String id) {
    AuditInformation auditInformation = createAuditInformation();
    Metadata metaData = createMetadata(id);
    ClubUpdateMessage message = ClubUpdateMessage.newBuilder().setId(id).build();
    eventPublisher.send(auditInformation, metaData, message);
  }
}`;
    const tree = await parseSource(src, "java" as any, "ClubEventServiceImpl.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.kind === "queue-publish" && d.target === "ClubUpdateMessage")).toBe(true);
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

  it("reads a request or reply sent on the bus as the event, on both sides", async () => {
    const src = `package x;
public class TransferEvents {
  private final EventPublisher publisher;
  void requestTransfer(TransferPlayerRequest message) {
    publisher.send(auditInformation(), metadata(message.getId()), message);
  }
  @MessageHandler
  public void handle(AuditInformation auditInformation, TransferPlayerResponse response) {}
}`;
    const tree = await parseSource(src, "java" as any, "TransferEvents.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.map((d) => `${d.kind} ${d.target}`).sort()).toEqual(["queue-consume TransferPlayerResponse", "queue-publish TransferPlayerRequest"]);
  });

  it("types a loosely declared payload parameter by the events its callers in the file hand it", async () => {
    const src = `package x;
public class LeagueEventPublisherImpl {
  private final EventPublisher eventPublisher;
  public void created(Club club, AuditInformation audit) {
    sendLeagueEvent(club, audit, ClubCreatedEvent.newBuilder().setClub(club.getId()).build());
  }
  public void deleted(Club club, AuditInformation audit) {
    sendLeagueEvent(club, audit, new ClubDeletedEvent(club.getId()));
  }
  private void sendLeagueEvent(Club club, AuditInformation audit, Object leagueEvent) {
    eventPublisher.send(audit, Metadata.newBuilder().setAffectedEntity(club.getId()).build(), leagueEvent);
  }
}`;
    const tree = await parseSource(src, "java" as any, "LeagueEventPublisherImpl.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.map((d) => `${d.kind} ${d.target} @${d.line}`)).toEqual(["queue-publish ClubCreatedEvent @11", "queue-publish ClubDeletedEvent @11"]);
  });

  it("reads past a generic `Message` payload parameter to the events its callers hold in locals", async () => {
    const src = `package x;
public class KitEventServiceImpl {
  private EventPublisher eventPublisher;
  public void kitCreated(KitEntity kit) {
    KitCreatedEvent message = KitCreatedEvent.newBuilder().build();
    sendKitMessage(kit, message);
  }
  public void kitRetired(KitEntity kit) {
    KitRetiredEvent message = KitRetiredEvent.newBuilder().build();
    sendKitMessage(kit, message);
  }
  protected void sendKitMessage(KitEntity kit, Message message) {
    eventPublisher.send(audit(), metadata(kit), message);
  }
}`;
    const tree = await parseSource(src, "java" as any, "KitEventServiceImpl.java");
    const s = q(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.map((d) => `${d.kind} ${d.target}`)).toEqual(["queue-publish KitCreatedEvent", "queue-publish KitRetiredEvent"]);
  });

  it("strips an upper-case DB tech suffix from a repository type", async () => {
    const src = `package x;
class DriverService {
  private final DriverDBRepository driverDb;
  void m(String id) { driverDb.findById(id); }
}`;
    const tree = await parseSource(src, "java" as any, "DriverService.java");
    const s = new JavaKotlinDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
    expect(s.some((d) => d.entity === "Driver")).toBe(true);
  });
});

describe("extension clients keyed by the entity class (Halo)", () => {
  it("reads the class literal, else the declared type of the object handed over", async () => {
    const java = `import run.halo.app.extension.ReactiveExtensionClient;
class GameServiceImpl {
  private final ReactiveExtensionClient client;
  Mono<Game> getGame(String name) { return client.fetch(Game.class, name); }
  Flux<Game> list() { return client.listAll(Game.class, options, sort); }
  Mono<Game> save(Game game) { return client.update(game); }
  Mono<Void> remove(String name, ExtensionClient other) { return client.delete(something); }
}`;
    const tree = await parseSource(java, "java", "GameServiceImpl.java");
    const rows = new JavaKotlinDataSourceExtractor().extract(tree, java).filter((d) => d.kind === "database");
    expect(rows.map((d) => `${d.name} ${d.entity ?? "-"} ${d.access}`)).toEqual([
      "client.fetch Game read",
      "client.listAll Game read",
      "client.update Game write",
      "client.delete - write",
    ]);
  });

  it("types a lambda's parameter from the call its chain starts with (real-repo FP)", async () => {
    const java = `import run.halo.app.extension.ExtensionClient;
class FixtureCountUpdater {
  private final ExtensionClient client;
  void reconcile(String name) {
    client.fetch(Fixture.class, name).ifPresent(fixture -> {
      fixture.getSpec().setPlayed(true);
      client.update(fixture);
    });
    client.list(Club.class, null, null).forEach(club -> client.update(club));
  }
}`;
    const tree = await parseSource(java, "java", "FixtureCountUpdater.java");
    const rows = new JavaKotlinDataSourceExtractor().extract(tree, java).filter((d) => d.kind === "database");
    expect(rows.map((d) => `${d.name} ${d.entity ?? "-"} ${d.access}`)).toEqual([
      "client.fetch Fixture read",
      "client.update Fixture write",
      "client.list Club read",
      "client.update Club write",
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
    session.get(Car.class, id);
    for (Brand c : brands) { em.remove(c); }`, "java");
    expect(db(rows)).toEqual([
      ["persist", "PersonAddress"],
      ["merge", "Person"],
      ["saveOrUpdate", "PersonAddress"],
      ["get", "Car"],
      ["remove", "Brand"],
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

describe("JVM HTTP — requests are read where they are built", () => {
  const api = (ds: DataSourceInfo[]) => ds.filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target}`);

  it("reads an OkHttp request URL and verb, and no call from client configuration", async () => {
    const ds = await sourcesOf(`
    val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).build()
    val req = Request.Builder().url("https://api.example.com/v1/cars").post(body).build()
    val get = Request.Builder().url("/api/health").build()`, "kotlin");
    expect(api(ds)).toEqual(["POST https://api.example.com/v1/cars", "GET /api/health"]);
  });

  it("reads java.net.http requests", async () => {
    const ds = await sourcesOf(`
    HttpRequest r = HttpRequest.newBuilder(URI.create("https://svc/api/items")).PUT(body).build();
    HttpRequest q = HttpRequest.newBuilder().uri(URI.create("/api/players")).GET().build();`, "java");
    expect(api(ds)).toEqual(["PUT https://svc/api/items", "GET /api/players"]);
  });

  it("keeps Kotlin template holes in the target, an absolute host as written", async () => {
    const ds = await sourcesOf(`
    val a = Request.Builder().url("$baseUrl/api/cars").build()
    val b = Request.Builder().url("https://api.example.com/v0/\${GarageConf.appId}/Cars").get().build()
    val c = Request.Builder().header("X-Key", key).url("\${this.baseUrl}/api/garages/$id").delete().build()
    val url = "https://api.example.com/v0/$garage/Cars?limit=$limit"
    val d = Request.Builder().url(url).build()
    val e = HttpRequest.newBuilder().uri(URI(endpoint + "/api/drivers")).POST(body).build()
    val f = Request.Builder().url("$other").build()
    val g = Request.Builder().url(other).build()
    val endpoint = "drivers/v1/active"
    val query = "?season=$season"
    val h = Request.Builder().method("POST", body).url("$baseUrl/$endpoint$query").build()`, "kotlin");
    expect(api(ds)).toEqual([
      "GET ${baseUrl}/api/cars",
      "GET https://api.example.com/v0/${GarageConf.appId}/Cars",
      "DELETE ${this.baseUrl}/api/garages/${id}",
      "GET https://api.example.com/v0/${garage}/Cars?limit=${limit}",
      "POST ${endpoint}/api/drivers",
      "POST ${baseUrl}/drivers/v1/active?season=${season}",
    ]);
  });

  it("reads Java concatenation inside new URI(…) and keeps a `$` in a Java literal as text", async () => {
    const ds = await sourcesOf(`
    HttpRequest r = HttpRequest.newBuilder(new URI(base + "/api/clubs/" + id)).build();
    HttpRequest q = HttpRequest.newBuilder(URI.create("/api/price$list")).build();`, "java");
    expect(api(ds)).toEqual(["GET ${base}/api/clubs/${id}", "GET /api/price$list"]);
  });
});

describe("dependency-injection annotations are read by name", () => {
  it("records @Autowired as injection and @Value as the configuration key it reads, not a parameter annotation whose argument says Value", async () => {
    const src = `package x
class ClubController(@Autowired val clubs: ClubService) {
  @field:Value("\${league.size}") lateinit var size: String
  fun list(@RequestParam(required = false, defaultValue = "true") active: Boolean, @JsonValue x: Int) {}
}`;
    const tree = await parseSource(src, "kotlin" as any, "ClubController.kt");
    const ds = new JavaKotlinDataSourceExtractor().extract(tree, src);
    expect(ds.filter((d) => d.kind === "import").map((d) => d.name)).toEqual(["Autowired"]);
    expect(ds.filter((d) => d.kind === "env").map((d) => d.target)).toEqual(["league.size"]);
  });
});

describe("the plain Kafka client", () => {
  it("consumes the topic a consumer subscribes to, an environment topic by its default", async () => {
    const s = (await sourcesOf(
      `    KafkaConsumer<String, ByteArray>(props).apply { subscribe(listOf(topic)) }`,
      "kotlin",
      `import org.apache.kafka.clients.consumer.KafkaConsumer
val topic: String = System.getenv("KAFKA_TOPIC") ?: "fixtures"`,
    )).filter((d) => d.kind === "queue-consume");
    expect(s.map((d) => `${d.name} ${d.target}`)).toEqual(["MQ: Kafka subscribe fixtures"]);
  });
});


describe("exchange() as an accessor", () => {
  it("does not take a ServerRequest's exchange() for a request (real-repo FP: 528 rows)", async () => {
    const ds = await sourcesOf(`
    super(request.exchange());
    ResponseEntity<Club> r = restTemplate.exchange("/clubs/" + id, HttpMethod.GET, null, Club.class);
    Mono<Club> m = webClient.get().uri("/clubs/{id}", id).retrieve().bodyToMono(Club.class);`, "java");
    // The RestTemplate and WebClient requests only — the RestTemplate one with its URL and verb.
    expect(ds.filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target}`)).toEqual(["GET /clubs/${id}", "retrieve null"]);
  });
});

describe("an outbox relay: SQL in constructor-set fields, a built JdbcTemplate, the plain RabbitMQ client", () => {
  it("reads each access's table and the publish's exchange (real-repo FP: the service's input and output both missing)", async () => {
    const src = `package x;
class TransferOutbox {
  private final NamedParameterJdbcTemplate deleteTemplate;
  private final JdbcTemplate jdbcTemplate;
  private final String select;
  private final String delete;
  private final Channel channel;

  TransferOutbox(JdbcTemplate jdbcTemplate, int batchSize) {
    this.jdbcTemplate = jdbcTemplate;
    this.deleteTemplate = new NamedParameterJdbcTemplate(jdbcTemplate);
    select = "SELECT id, exchange, body FROM transfer_outbox ORDER BY id ASC LIMIT " + batchSize;
    this.delete = "DELETE FROM transfer_outbox WHERE id IN (:ids)";
  }

  List<Transfer> next() { return jdbcTemplate.query(select, mapper); }
  void remove(List<Long> ids) { deleteTemplate.update(delete, Map.of("ids", ids)); }
  long probe(DataSource ds) { return new JdbcTemplate(ds).queryForObject("SELECT count(*) FROM transfer_outbox WHERE id = 0", Long.class); }
  void publish(Transfer t) throws IOException { channel.basicPublish("league.transfers", t.routingKey(), null, t.body()); }
}`;
    const tree = await parseSource(src, "java" as any, "TransferOutbox.java");
    const ds = new JavaKotlinDataSourceExtractor().extract(tree, src);
    const db = ds.filter((d) => d.kind === "database").map((d) => `${d.name} ${d.entity ?? d.target}`);
    expect(db).toEqual(expect.arrayContaining(["query transfer_outbox", "update transfer_outbox", "queryForObject transfer_outbox"]));
    expect(ds.filter((d) => d.kind === "queue-publish").map((d) => `${d.name} ${d.target}`)).toEqual(["MQ: basicPublish league.transfers"]);
  });
});

describe("java.net URLConnection", () => {
  it("reads openConnection() as a GET of the URL it is opened on", async () => {
    const ds = await sourcesOf(`
    URLConnection a = new URL("http://stats.example.com/api/clubs").openConnection();
    URLConnection b = URI.create(url).toURL().openConnection();`, "java");
    expect(ds.filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target}`)).toEqual(["GET http://stats.example.com/api/clubs", "GET null"]);
  });
});

describe("Spring application listeners", () => {
  it("consume the event their ApplicationListener<X> names, in onApplicationEvent (real-repo FP)", async () => {
    const java = `class StandingsRefresher implements StandingsSource, ApplicationListener<MatchFinishedEvent> {
  @Override
  public void onApplicationEvent(MatchFinishedEvent event) {
    refresh(event.getLeague());
  }
}`;
    const tree = await parseSource(java, "java", "StandingsRefresher.java");
    const rows = new JavaKotlinDataSourceExtractor().extract(tree, java).filter((d) => d.kind === "queue-consume");
    expect(rows.map((d) => `${d.name} ${d.target} @${d.line}`)).toEqual(["ApplicationListener MatchFinishedEvent @3"]);
  });

  it("publish the event a method of the file builds and returns", async () => {
    const java = `class StandingsReconciler {
  private final ApplicationEventPublisher eventPublisher;
  void reconcile(Table table) {
    eventPublisher.publishEvent(computeChangedEvent(table));
  }
  private StandingsChangedEvent computeChangedEvent(Table table) {
    return new StandingsChangedEvent(this, table);
  }
}`;
    const tree = await parseSource(java, "java", "StandingsReconciler.java");
    const rows = new JavaKotlinDataSourceExtractor().extract(tree, java).filter((d) => d.kind === "queue-publish");
    expect(rows.map((d) => `${d.target} @${d.line}`)).toEqual(["StandingsChangedEvent @4"]);
  });
});
