import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { CSharpExtractor } from "./functions-classes.js";

async function propsOf(src: string): Promise<string[]> {
  const tree = await parseSource(src, "csharp", "ClubViewModel.cs");
  const [cls] = new CSharpExtractor().extractClasses(tree, src);
  return (cls?.properties ?? []).map((p) => `${p.name}:${p.type}${p.accessor ? " (generated)" : ""}`);
}

describe("CommunityToolkit [ObservableProperty]", () => {
  it("gives the field its generated public property, typed as the field", async () => {
    const props = await propsOf(`public partial class ClubViewModel : ObservableObject {
  [ObservableProperty] private string _clubName;
  [ObservableProperty]
  private Squad squad;
  private int plain;
}`);
    expect(props).toEqual(["_clubName:string", "squad:Squad", "plain:int", "ClubName:string (generated)", "Squad:Squad (generated)"]);
  });

  it("does not repeat a property the class declares", async () => {
    const props = await propsOf(`public class ClubViewModel {
  [ObservableProperty] private string _name;
  public string Name { get; set; }
}`);
    expect(props.filter((p) => p.startsWith("Name:"))).toEqual(["Name:string"]);
  });
});
