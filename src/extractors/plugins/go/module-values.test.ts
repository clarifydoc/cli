import { describe, expect, it } from "vitest";
import { extractGoModuleValues } from "./module-values.js";

const lines = (s: string) => s.split("\n");

describe("Go package-level string values", () => {
  it("reads constants, blocks and values built from other names, never a function's locals", () => {
    const values = extractGoModuleValues(lines(`package config

// ApiUri is where the REST API is served.
const ApiUri = "/api/v1"

const DownloadUri = ApiUri + "/dl"

const (
\tStaticUri string = "/static"
\tLeagueTopic = league.Prefix + ".matches"
\tWelcome = "Hello, %s"
)

var Garage = \`/garage\`

func load() {
\tconst local = "/not-a-package-value"
}
`));
    expect(values).toEqual({
      ApiUri: "/api/v1",
      DownloadUri: "${ApiUri}/dl",
      StaticUri: "/static",
      LeagueTopic: "${league.Prefix}.matches",
      Garage: "/garage",
    });
  });

  it("reads a variable set by a function of the file as that function's one literal result", () => {
    const values = extractGoModuleValues(lines(`package kafka

var (
\tTopic           = getTopic()
\tProtocolVersion = sarama.V3_0_0_0
\tBroker          = pickBroker()
)

func getTopic() string {
\tif topic := os.Getenv("KAFKA_TOPIC"); topic != "" {
\t\treturn topic
\t}
\treturn "matches"
}

func pickBroker() string {
\tif fast {
\t\treturn "broker-a"
\t}
\treturn "broker-b"
}
`));
    expect(values).toEqual({ Topic: "matches" });
  });

  it("leaves out a name declared twice with different values", () => {
    expect(extractGoModuleValues(lines(`package x

const Club = "/a"
const Club = "/b"
const Car = "/garage"
`))).toEqual({ Car: "/garage" });
  });
});

describe("Go struct fields the program sets from the environment (real-repo FP)", () => {
  it("names the variable a field is set from, through a setter handed the field or an assignment", () => {
    const lines = `package main

type frontendServer struct {
	scoutSvcAddr  string
	ticketSvcAddr string
}

func main() {
	svc := new(frontendServer)
	mustMapEnv(&svc.scoutSvcAddr, "SCOUT_SERVICE_ADDR")
	svc.ticketSvcAddr = os.Getenv("TICKET_SERVICE_ADDR")
	mustMapEnv(&other.addr, "OTHER_ADDR")
}

func mustMapEnv(target *string, envKey string) {
	v := os.Getenv(envKey)
	if v == "" {
		panic("unset")
	}
	*target = v
}
`.split("\n");
    expect(extractGoModuleValues(lines)).toEqual({
      "frontendServer.scoutSvcAddr": '${os.Getenv("SCOUT_SERVICE_ADDR")}',
      "frontendServer.ticketSvcAddr": '${os.Getenv("TICKET_SERVICE_ADDR")}',
    });
  });
});
