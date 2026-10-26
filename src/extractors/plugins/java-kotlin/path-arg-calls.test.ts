import { describe, expect, it } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import { JavaKotlinDataSourceExtractor, extractJavaPathArgCalls } from "./data-sources.js";
import { expandRequestFactories } from "../../../core/api-targets.js";
import { buildImportIndex } from "../../../core/import-index.js";
import { createEmptyAnalysis, type DataSourceInfo } from "../../../types/analysis.js";

const CLIENT = `package com.example.league;

import org.keycloak.http.simple.SimpleHttp;

public class RefereeClient {
    private static final String API_PATH = "/rp/v2";
    private final SimpleHttp http;
    private final String apiUrl;

    public Order assign(String matchId) {
        return post("/assign", Map.of("matchId", matchId));
    }

    public void cancel(String orderRef) {
        post("/cancel", Map.of("orderRef", orderRef));
    }

    private JsonNode post(String path, Map<String, ?> body) {
        String url = apiUrl + API_PATH + path;
        try (SimpleHttpResponse response = http.doPost(url).json(body).asResponse()) {
            return response.asJson();
        }
    }
}
`;

describe("Java request helpers handed a path", () => {
  it("fills the helper's path at each call site, the file's constant included", async () => {
    const tree = await parseSource(CLIENT, "java" as never, "RefereeClient.java");
    const a = createEmptyAnalysis("src/main/java/com/example/league/RefereeClient.java", "java");
    const ex = new JavaKotlinExtractor();
    a.classes = ex.extractClasses(tree, CLIENT);
    a.dataSources = new JavaKotlinDataSourceExtractor().extract(tree, CLIENT);
    a.pathArgCalls = extractJavaPathArgCalls(tree);
    expect(a.dataSources.filter((d) => d.kind === "api-call").map((d) => d.target)).toEqual(["${apiUrl}/rp/v2${path}"]);
    expect(a.pathArgCalls.map((c) => [c.callee, c.args[0]])).toEqual([["post", "/assign"], ["post", "/cancel"]]);
    const calls = a.dataSources.filter((d) => d.kind === "api-call").map((d) => ({ ...d, filePath: a.filePath })) as Array<DataSourceInfo & { filePath: string }>;
    expect(expandRequestFactories(calls, [a], buildImportIndex([a]))).toBe(2);
    expect(calls.map((c) => `${c.name} ${c.target}`).slice(1)).toEqual(["POST ${apiUrl}/rp/v2/assign", "POST ${apiUrl}/rp/v2/cancel"]);
  });
});
