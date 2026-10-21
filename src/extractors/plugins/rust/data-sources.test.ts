import { describe, it, expect } from "vitest";
import { extractRustDataSources } from "./data-sources.js";

describe("Rust HTTP calls", () => {
  it("follow a client's chain onto the next line, and a format! URL in a local (real-repo FP)", () => {
    const src = `async fn request_quote(count: u32) -> Result<f64, anyhow::Error> {
    let client = awc::Client::new();
    let quote_addr: String = format!(
        "{}{}",
        env::var("QUOTE_ADDR")
            .unwrap_or_else(|_| "http://quote:8090".to_string()),
        "/getquote"
    );
    let mut response = client
        .post(quote_addr)
        .send_json(&body)
        .await?;
    let plain = "https://garage.example.com/cars";
    let cars = reqwest_client.get(plain).send().await?;
}`;
    const calls = extractRustDataSources(src.split("\n")).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => `${c.name} ${c.target} @${c.line}`)).toEqual([
      'POST ${env::var("QUOTE_ADDR").unwrap_or_else(|_|"http://quote:8090".to_string())}/getquote @10',
      "GET https://garage.example.com/cars @14",
    ]);
  });
});
