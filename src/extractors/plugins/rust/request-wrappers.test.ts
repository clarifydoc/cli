import { describe, it, expect } from "vitest";
import { extractRustPathArgCalls, readRustCode, rustClientRequests, rustTypeName } from "./request-wrappers.js";

const lines = (s: string) => s.split("\n");

describe("Rust request wrappers", () => {
  const WRAPPER = lines(`use reqwest::Method;

pub struct Api {
    http: Http,
    origin: String,
}

impl Api {
    pub fn post(&self, path: &str) -> RequestBuilder {
        self.request(Method::POST, path)
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.http
            .api_client
            .request(method, api_url(&self.origin, path))
    }
}
`);

  it("reads the client request inside the wrapper as a request of its path parameter", () => {
    const rows = rustClientRequests(readRustCode(WRAPPER));
    expect(rows.map((r) => [r.line, r.name, r.target])).toEqual([[16, "request", "${self.origin}${path}"]]);
  });

  it("names the wrapper's own call of its request method, typed by the impl", () => {
    expect(extractRustPathArgCalls(WRAPPER)).toEqual([
      { callee: "request", args: [null, null], argNames: [null, "path"], line: 10, receiverType: "Api", method: "POST" },
      // A helper handed the path: core expands it only if it is itself a factory.
      { callee: "api_url", args: [null, null], argNames: [null, "path"], line: 16 },
    ]);
  });

  it("names a call site through a parameter's fields, a format! path and a verb argument", () => {
    const sites = extractRustPathArgCalls(lines(`pub async fn renew(session: &league_core::Session, club_id: &str) {
    session
        .api
        .post(&format!("/clubs/{club_id}/contract/{}", "renew"))
        .send();
}

pub async fn release(api: Arc<Api>, id: u64) {
    api.delete(&format!("/players/{}", id)).send();
}

pub async fn transfer(session: &Session) {
    club_request(session, "/players/transfer", Method::POST).await;
    let local = make();
    local.post("/clubs/ignored");
    log("no path here");
}
`));
    expect(sites).toEqual([
      { callee: "post", args: ["/clubs/${club_id}/contract/renew"], line: 4, receiverType: "Session", receiverFields: ["api"] },
      { callee: "delete", args: ["/players/${id}"], line: 9, receiverType: "Api" },
      { callee: "club_request", args: [null, "/players/transfer", null], line: 13, method: "POST" },
    ]);
  });

  it("reads the type a parameter declares through references and pointers", () => {
    expect(rustTypeName("&'a mut league::Session")).toBe("Session");
    expect(rustTypeName("Arc<dyn ClubApi>")).toBe("ClubApi");
    expect(rustTypeName("&str")).toBeNull();
  });
});
