import { describe, it, expect } from "vitest";
import { receiverTypeName, registerTransparentTypeWrappers } from "./type-parser.js";

describe("receiverTypeName — the class a declared type dispatches member calls to", () => {
  it("strips nullability, pointers, references, qualifiers and quotes", () => {
    for (const raw of ["?Repo", "Repo?", "Repo!", "Repo|null", "Repo | undefined", "null | Repo", "*Repo", "&Repo",
      "&'a dyn Repo", "&mut Repo", "\"Repo\"", "App\\Repo\\Repo", "\\App\\Repo", "pkg.Repo", "crate::repo::Repo", "readonly Repo"]) {
      expect(receiverTypeName(raw, "typescript"), raw).toBe("Repo");
    }
  });

  it("keeps a generic type itself, and unwraps only registered transparent wrappers", () => {
    expect(receiverTypeName("IRepository<User>", "csharp")).toBe("IRepository");
    // Java's Optional is a real container (calls go through `.get()`): never unwrapped.
    expect(receiverTypeName("Optional<Repo>", "java")).not.toBe("Repo");
    registerTransparentTypeWrappers("rust", ["Arc", "Box", "Rc"]);
    expect(receiverTypeName("Arc<dyn Repo + Send + Sync>", "rust")).toBe("Repo");
    expect(receiverTypeName("std::sync::Arc<dyn Repo>", "rust")).toBe("Repo");
    registerTransparentTypeWrappers("python", ["Annotated"]);
    expect(receiverTypeName("Annotated[Repo, Depends(get_repo)]", "python")).toBe("Repo");
  });

  it("reads Python's typing forms in bracket syntax only", () => {
    expect(receiverTypeName("Optional[Repo]", "python")).toBe("Repo");
    expect(receiverTypeName("Union[Repo, None]", "python")).toBe("Repo");
    expect(receiverTypeName("Union[Repo, Cache]", "python")).toBeNull();
    expect(receiverTypeName("Repo | None", "python")).toBe("Repo");
  });

  it("reads Swift existential and opaque spellings", () => {
    for (const raw of ["any Repo", "some Repo", "(any Repo)?", "(any Repo)!"]) {
      expect(receiverTypeName(raw, "swift"), raw).toBe("Repo");
    }
    expect(receiverTypeName("(Int) -> Int", "swift")).toBeNull();
  });

  it("refuses collections, ambiguous unions, intersections and non-types", () => {
    for (const raw of ["Repo[]", "[]Repo", "[Repo]", "map[string]Repo", "chan Repo", "A | B", "A & B", "Fn(u32) -> u32", "", null]) {
      expect(receiverTypeName(raw as string, "typescript"), String(raw)).toBeNull();
    }
  });
});
