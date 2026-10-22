import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { dartSpec } from "./index.js";

/** Real-repo FP: ~1,300 Dart functions with a wrapped signature dropped, with 61% of the event dispatch sites. */
const SRC = `class ClubBackendService {
  static Future<FlowyResult<ClubPB, FlowyError>> createClub({
    required String leagueId,
    String? name,
  }) {
    final payload = CreateClubPayloadPB(leagueId: leagueId, name: name);
    return LeagueEventCreateClub(payload).send();
  }

  static Future<FlowyResult<PlayerPB, FlowyError>>
      getCaptain(String clubId) async {
    return LeagueEventGetCaptain(ClubIdPB(value: clubId)).send();
  }

  void _transfer(
    String playerId,
    String toClub,
  ) {
    TransferEvent.move(playerId, toClub);
  }
}

class SelectSquadBloc extends Bloc<SelectSquadEvent, SelectSquadState> {
  SelectSquadBloc({
    required this.squadId,
  }) : super(SelectSquadState.initial()) {
    on<SelectSquadEvent>((event, emit) async {
      await LeagueEventUpdateSquad(event.payload).send();
    });
  }
  final String squadId;
}
`;

describe("Dart signatures over several lines", () => {
  it("are methods with their calls", () => {
    const lines = SRC.split("\n");
    const fns = extractFunctionsWithSpec(lines, dartSpec);
    const [service, bloc] = dartSpec.extractClasses!(lines, fns);
    const m = (cls: typeof service, name: string) => cls!.methods.find((x) => x.name === name);
    expect(m(service, "createClub")?.calls.map((c) => c.name)).toContain("LeagueEventCreateClub");
    expect(m(service, "getCaptain")).toMatchObject({ isAsync: true });
    expect(m(service, "getCaptain")?.calls.map((c) => c.name)).toContain("LeagueEventGetCaptain");
    expect(m(service, "_transfer")?.calls.map((c) => c.name)).toContain("TransferEvent.move");
    expect(m(bloc, "SelectSquadBloc")?.calls.map((c) => c.name)).toContain("LeagueEventUpdateSquad");
    expect(extractFunctionsWithSpec(lines, dartSpec).map((f) => f.name)).toEqual(expect.arrayContaining(["createClub", "getCaptain", "_transfer"]));
  });
});
