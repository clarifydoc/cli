import { describe, it, expect } from "vitest";
import { CSharpMediatrResolver } from "./dispatch.js";
import type { CallInfo, ClassInfo, FileAnalysis, FunctionInfo, ParamInfo } from "../../../types/analysis.js";

const call = (name: string, line = 1): CallInfo => ({ name, kind: "internal", target: null, line });
const param = (name: string, type: string): ParamInfo => ({ name, type, defaultValue: null });

const method = (
  name: string,
  line: number,
  calls: CallInfo[] = [],
  params: ParamInfo[] = [],
): FunctionInfo =>
  ({ name, line, endLine: line + 3, params, calls } as unknown as FunctionInfo);

const cls = (name: string, opts: Partial<ClassInfo> & { methods: FunctionInfo[] }): ClassInfo =>
  ({
    name,
    kind: "class",
    extends: opts.extends ?? null,
    implements: opts.implements ?? [],
    methods: opts.methods,
    properties: [],
    decorators: [],
    line: opts.line ?? 1,
    endLine: opts.endLine ?? 50,
  } as unknown as ClassInfo);

const file = (filePath: string, classes: ClassInfo[], functions: FunctionInfo[] = []): FileAnalysis =>
  ({ filePath, language: "csharp", classes, functions } as unknown as FileAnalysis);

function run(files: FileAnalysis[]) {
  return new CSharpMediatrResolver().resolve(files);
}

describe("CSharpMediatrResolver", () => {
  const handlerFile = file("App/Owners/GetOwnersQuery.cs", [
    cls("GetOwnersQueryHandler", {
      extends: "IRequestHandler<GetOwnersQuery, List<Owner>>",
      methods: [method("Handle", 15, [call("_db.Owners.ToListAsync")])],
    }),
  ]);
  const cmdHandlerFile = file("App/Owners/CreateOwnerCommand.cs", [
    cls("CreateOwnerCommandHandler", {
      extends: "IRequestHandler<CreateOwnerCommand, Guid>",
      methods: [method("Handle", 14, [call("_db.Owners.Add")])],
    }),
  ]);

  it("links a controller action that constructs a request to its handler's Handle", () => {
    const ctrl = file("Api/OwnersController.cs", [
      cls("OwnersController", {
        methods: [method("GetAll", 15, [call("_mediator.Send", 16), call("new GetOwnersQuery", 16)])],
      }),
    ]);
    const links = run([ctrl, handlerFile]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceFile: "Api/OwnersController.cs",
      sourceSymbol: "OwnersController.GetAll",
      targetFile: "App/Owners/GetOwnersQuery.cs",
      targetSymbol: "GetOwnersQueryHandler.Handle",
      targetLine: 15,
      callName: "Send(GetOwnersQuery)",
      confidence: "INFERRED",
    });
  });

  it("links a request forwarded as a parameter (Send(command))", () => {
    const ctrl = file("Api/OwnersController.cs", [
      cls("OwnersController", {
        methods: [
          method("Create", 27, [call("_mediator.Send", 28)], [
            param("command", "CreateOwnerCommand"),
            param("ct", "CancellationToken"),
          ]),
        ],
      }),
    ]);
    const links = run([ctrl, cmdHandlerFile]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceSymbol: "OwnersController.Create",
      targetSymbol: "CreateOwnerCommandHandler.Handle",
      callName: "Send(CreateOwnerCommand)",
    });
  });

  it("does not treat a non-mediator .Send() as a dispatch", () => {
    const ctrl = file("Api/SocketController.cs", [
      cls("SocketController", {
        methods: [method("Push", 10, [call("_socket.Send", 11)], [param("msg", "GetOwnersQuery")])],
      }),
    ]);
    expect(run([ctrl, handlerFile])).toHaveLength(0);
  });

  it("never self-links the handler's own Handle method", () => {
    // Handle receives the request as a param; if it also dispatched, it must not link to itself.
    const selfish = file("App/Owners/GetOwnersQuery.cs", [
      cls("GetOwnersQueryHandler", {
        extends: "IRequestHandler<GetOwnersQuery, List<Owner>>",
        methods: [method("Handle", 15, [call("_mediator.Send", 16)], [param("request", "GetOwnersQuery")])],
      }),
    ]);
    expect(run([selfish])).toHaveLength(0);
  });

  it("returns nothing when no handlers exist", () => {
    const ctrl = file("Api/OwnersController.cs", [
      cls("OwnersController", {
        methods: [method("GetAll", 15, [call("_mediator.Send", 16), call("new GetOwnersQuery", 16)])],
      }),
    ]);
    expect(run([ctrl])).toHaveLength(0);
  });
});
