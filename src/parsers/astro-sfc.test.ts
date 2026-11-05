import { describe, it, expect } from "vitest";
import { astroFrontmatter, blankExceptAstroCode, parseAstro } from "./astro-sfc.js";

describe("Astro component parser", () => {
  const source = `---
import Layout from '../layouts/Layout.astro';
const club = await getClub();
---
<Layout title="Club"><ClubCard client:load club={club} /><hr/></Layout>
<script>
  console.log('ready');
</script>
`;

  it("finds the frontmatter between the fences, and none without them", () => {
    const fm = astroFrontmatter(source)!;
    expect(source.slice(fm.start, fm.end)).toBe("import Layout from '../layouts/Layout.astro';\nconst club = await getClub();\n");
    expect(astroFrontmatter("<h1>---</h1>\n---\n")).toBeNull();
    expect(astroFrontmatter("---\r\nconst a = 1;\r\n---\r\n<p/>")).not.toBeNull();
    expect(astroFrontmatter("---\nnever closed\n")).toBeNull();
  });

  it("keeps the code lines in place and blanks the markup", () => {
    const code = blankExceptAstroCode(source);
    expect(code.length).toBe(source.length);
    expect(code.split("\n")[1]).toBe("import Layout from '../layouts/Layout.astro';");
    expect(code.split("\n")[4]!.trim()).toBe("");
    expect(code).toContain("console.log('ready');");
    expect(code).not.toContain("<Layout");
  });

  it("reads component tags from the markup alone", () => {
    const names = parseAstro(source).templateComponents.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Layout", "ClubCard"]));
    expect(names).not.toContain("getClub");
  });
});
