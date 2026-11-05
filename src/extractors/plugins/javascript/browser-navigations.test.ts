import { describe, expect, it } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractBrowserNavigations } from "./browser-navigations.js";

const navigations = async (src: string) => extractBrowserNavigations(await parseSource(src, "typescript" as never, "x.spec.ts"), src);

describe("pages a browser test opens", () => {
  it("reads Playwright, Cypress and WebdriverIO navigations, holes as parameters", async () => {
    const src = `import { test } from '../support/fixtures'
const squadRoute = '/clubs/7/squad'
test('shows the squad', async ({ authenticatedPage: page, club }) => {
  await page.goto('/clubs/1/settings/kits?tab=home')
  await page.goto(\`/clubs/\${club.id}/players\`)
  await page.goto(squadRoute)
  const transfers = \`/clubs/\${club.id}/transfers\`
  await page.goto(transfers)
  await adminPage.goto('http://localhost:4173/league')
  await page.goto(\`\${baseURL}/fixtures\`)
})
class LoginPage {
  async open(clubId) { await this.page.goto(\`/clubs/\${clubId}/login\`) }
}
it('signs in', () => { cy.visit('/login') })
it('opens the garage', async () => { await browser.url('/garage') })
`;
    expect(await navigations(src)).toEqual([
      { path: "/clubs/1/settings/kits", line: 4 },
      { path: "/clubs/{}/players", line: 5 },
      { path: "/clubs/7/squad", line: 6 },
      { path: "/clubs/{}/transfers", line: 8 },
      { path: "/league", line: 9 },
      { path: "/fixtures", line: 10 },
      { path: "/clubs/{}/login", line: 13 },
      { path: "/login", line: 15 },
      { path: "/garage", line: 16 },
    ]);
  });

  it("another host, a relative address, a computed one or another object's goto is no page of the app", async () => {
    const src = `test('x', async ({ page }) => {
  await page.goto('https://example.com/clubs')
  await page.goto('clubs')
  await page.goto(urlFor('clubs'))
  await page.goto(nextUrl)
  router.goto('/clubs')
  await page.goBack()
})
`;
    expect(await navigations(src)).toEqual([]);
  });
});
