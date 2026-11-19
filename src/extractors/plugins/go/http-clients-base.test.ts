import { describe, expect, it } from "vitest";
import { extractGoDataSources } from "./data-sources.js";
import { extractGoHttpClientRegistrations } from "./http-clients.js";

const lines = (s: string) => s.split("\n");

describe("Go clients with a stated base", () => {
  it("keys a resty client by its name, a split chain and a later SetBaseURL included", () => {
    const src = `package main
import "github.com/go-resty/resty/v2"
var client = resty.New().SetBaseURL("http://league-api:8080")
var other = resty.New().
  SetTimeout(1).
  SetHostURL("http://cars-api:8080")
var late = resty.New()
func init() {
	late.SetBaseURL(os.Getenv("PLAYER_URL"))
}
var bare = resty.New()
func a() {
  testURL := "http://localhost:1"
  client.R().Get("/clubs")
  other.R().Get("/cars")
  s.late.R().Get("/players")
  bare.R().Get("/free")
}`;
    expect(extractGoHttpClientRegistrations(lines(src)).map((r) => [r.client, r.base])).toEqual([
      ["client", { kind: "literal", key: "http://league-api:8080" }],
      ["other", { kind: "literal", key: "http://cars-api:8080" }],
      ["late", { kind: "env", key: "PLAYER_URL" }],
    ]);
    const calls = extractGoDataSources(lines(src)).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => [c.target, c.client ?? null])).toEqual([["/clubs", "client"], ["/cars", "other"], ["/players", "late"], ["/free", null]]);
  });

  it("names a URL-holding field on the request that joins its path onto it", () => {
    const src = `package main
import "net/http"
func NewApi() *Api { return &Api{baseURL: "http://league-api:8080"} }
func (a *Api) Players() { http.NewRequest("GET", a.baseURL+"/players", nil) }
func (a *Api) Other(u string) { http.NewRequest("GET", a.rawURL+"/cars", nil) }`;
    const calls = extractGoDataSources(lines(src)).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => [c.target, c.client ?? null])).toEqual([["${a.baseURL}/players", "baseURL"], ["${a.rawURL}/cars", null]]);
  });
});
