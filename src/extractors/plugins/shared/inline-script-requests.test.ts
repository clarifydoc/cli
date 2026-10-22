import { describe, it, expect } from "vitest";
import { inlineScriptRequests } from "./inline-script-requests.js";

describe("inline script requests", () => {
  it("read a page's fetch, axios and jQuery calls to its own app, with their method (real-repo FP)", () => {
    const page = `<html><body>
<form id="signup"></form>
<script th:inline="javascript">
  async function sendCode(email) {
    const response = await fetch("/signup/send-email-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const clubs = await fetch(\`/clubs/\${clubId}/players\`);
    axios.delete("/fixtures/42");
    $.getJSON("/standings");
    fetch("https://cdn.example.com/badges.json");
    url = document.getElementById('edtUrl').value;
    fetch(url + '/standings/json', { method: 'GET' });
  }
</script>
<script src="/js/app.js"></script>
</body></html>`;
    expect(inlineScriptRequests(page.split("\n")).map((d) => `${d.name} @${d.line}`)).toEqual([
      "POST /signup/send-email-code @5",
      "GET /clubs/:param/players @10",
      "DELETE /fixtures/42 @11",
      "GET /standings @12",
      "GET https://cdn.example.com/badges.json @13",
      "GET ${url}/standings/json @15",
    ]);
  });
});
