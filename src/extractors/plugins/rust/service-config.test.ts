import { describe, it, expect } from "vitest";
import { rustBaseRefOf } from "./service-config.js";

describe("rustBaseRefOf", () => {
  it("reads an environment variable, with the fallback literal when the chain ends on it", () => {
    // The chain goes on after the fallback: the literal is not the value, so none is stated.
    expect(rustBaseRefOf('env::var("MATCH_ADDR").unwrap_or_else(|_| "http://match:8090".to_string()).parse::<String>().expect("bad")')).toEqual({ kind: "env", key: "MATCH_ADDR" });
    expect(rustBaseRefOf('std::env::var("MATCH_ADDR").unwrap_or("http://match:8090".to_string())')).toEqual({ kind: "env", key: "MATCH_ADDR", fallback: "http://match:8090" });
    expect(rustBaseRefOf('std::env::var_os("MATCH_ADDR")')).toEqual({ kind: "env", key: "MATCH_ADDR" });
  });

  it("reads nothing from a namesake: a project module, a method, a nested argument, a local", () => {
    expect(rustBaseRefOf('league_env::var("MATCH_ADDR")')).toBeNull();
    expect(rustBaseRefOf('club.env::var("MATCH_ADDR")')).toBeNull();
    expect(rustBaseRefOf('settings.var("MATCH_ADDR")')).toBeNull();
    expect(rustBaseRefOf('join(env::var("MATCH_ADDR"), "x")')).toBeNull();
    expect(rustBaseRefOf('env!("MATCH_ADDR")')).toBeNull();
    expect(rustBaseRefOf('option_env!("MATCH_ADDR")')).toBeNull();
    expect(rustBaseRefOf('env::var("MATCH_ADDR").map(|h| format!("{h}/v2"))')).toBeNull();
    expect(rustBaseRefOf("match_addr")).toBeNull();
    expect(rustBaseRefOf("self.base_url")).toBeNull();
  });
});
