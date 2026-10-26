import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Events published through a helper taking `Object event`, built one frame up
 * in each subclass (real-repo FP: a service whose every publish went through
 * such a helper published nothing).
 */
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId></project>`,
  "src/main/java/com/example/league/EventEmitter.java": `package com.example.league;

import java.util.function.Supplier;
import com.google.protobuf.Message;
import com.google.protobuf.Message.Builder;

public abstract class EventEmitter {
    @Autowired
    protected EventPublisher eventPublisher;

    protected final void emit(Club club, Object event) {
        eventPublisher.send(createAuditData(), createMetaData(club.getId()), event);
    }

    protected final void emitSubEntity(Player player, Object event) {
        eventPublisher.send(createAuditData(), createMetaData(player.getClubId()), event);
    }

    protected final void emitMessage(String id, Builder builder) {
        emitMessage(id, builder.build());
    }

    protected final void emitMessage(String id, Message msg) {
        eventPublisher.send(createAuditData(), createMetaData(id), msg);
    }

    protected static <E> E event(Supplier<E> constructor) {
        E event = constructor.get();
        return event;
    }
}
`,
  "src/main/java/com/example/league/PlayerEventEmitter.java": `package com.example.league;

public class PlayerEventEmitter extends EventEmitter {
    public void fireSigned(Player player) {
        PlayerSignedEvent event = event(PlayerSignedEvent::new);
        emitSubEntity(player, event);
    }

    public void fireReleased(Player player) {
        emitSubEntity(player, new PlayerReleasedEvent(player.getId()));
    }

    public void fireOther(Player player, Object payload) {
        emitSubEntity(player, payload);
    }
}
`,
  "src/main/java/com/example/league/MatchEventEmitter.java": `package com.example.league;

public class MatchEventEmitter extends EventEmitter {
    public void fireStarted(Match match) {
        emitMessage(match.getId(), MatchStartedEvent.newBuilder()
            .setMatchId(match.getId()));
    }

    public void fireAbandoned(Match match) {
        emitMessage(match.getId(), MatchAbandonedEvent.getDefaultInstance());
    }
}
`,
};

describe("events published through an Object-typed helper", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  let base: FileAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-helper-publish-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
    base = JSON.parse(await readFile(join(dir, "out", "src/main/java/com/example/league/EventEmitter.java.json"), "utf8"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("analyzes a file whose receiver is named like an Object member (`constructor.get()`)", () => {
    expect(base.classes.map((c) => c.name)).toEqual(["EventEmitter"]);
  });

  it("publishes, at each subclass call, the event type it hands the helper", () => {
    const queues = (summary.dataAccessGraph?.nodes ?? []).filter((n) => n.kind === "queue").map((n) => n.name).sort();
    // The protobuf base `Message` a helper parameter is typed as is no event of its own.
    expect(queues).toEqual(["MatchAbandonedEvent", "MatchStartedEvent", "PlayerReleasedEvent", "PlayerSignedEvent"]);
  });
});
