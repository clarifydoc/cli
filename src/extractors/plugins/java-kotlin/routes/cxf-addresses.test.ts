import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";
import { cxfAddressPath } from "../../shared/cxf-service-beans.js";

/**
 * CXF endpoints publish their routes under their address (real-repo FP: an
 * OSGi Blueprint `jaxrs-context.xml` was never read, and the routes lacked the
 * deployed prefix). Labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId>
<dependencies><dependency><groupId>org.apache.cxf</groupId><artifactId>cxf-rt-frontend-jaxrs</artifactId></dependency></dependencies></project>`,
  "club-api/src/main/java/com/example/league/api/ClubRepository.java": `package com.example.league.api;

import javax.ws.rs.*;

@Path("/v1/clubs")
public interface ClubRepository {
    @GET
    List<Club> getClubs();

    @GET
    @Path("/{clubId}")
    Club getClub(@PathParam("clubId") String clubId);
}
`,
  "club-service/src/main/java/com/example/league/impl/ClubRepositoryImpl.java": `package com.example.league.impl;

import com.example.league.api.ClubRepository;

public class ClubRepositoryImpl implements ClubRepository {
    public List<Club> getClubs() { return null; }
    public Club getClub(String clubId) { return null; }
}
`,
  "club-service/src/main/resources/OSGI-INF/blueprint/jaxrs-context.xml": `<?xml version="1.0" encoding="UTF-8"?>
<blueprint xmlns="http://www.osgi.org/xmlns/blueprint/v1.0.0" xmlns:jaxrs="http://cxf.apache.org/blueprint/jaxrs">
    <jaxrs:server id="clubEndpoint" address="/club-service/repository">
        <jaxrs:serviceBeans>
            <reference interface="com.example.league.api.ClubRepository" />
        </jaxrs:serviceBeans>
        <jaxrs:providers>
            <ref component-id="jsonProvider" />
        </jaxrs:providers>
    </jaxrs:server>
    <bean id="jsonProvider" class="com.example.league.JsonProvider" />
</blueprint>
`,
  // The same service in a Spring context whose address is all placeholders: it states no path.
  "club-service/src/main/resources/META-INF/applicationContext.xml": `<beans xmlns:jaxrs="http://cxf.apache.org/jaxrs">
  <jaxrs:server id="clubRs" address="http://\${server.hostname}:\${server.port}\${server.servicename}">
    <jaxrs:serviceBeans><ref bean="clubRepository"/></jaxrs:serviceBeans>
  </jaxrs:server>
  <bean id="clubRepository" class="com.example.league.impl.ClubRepositoryImpl"/>
</beans>
`,
  // A test's embedded server publishes nothing.
  "club-service/src/test/resources/test-applicationContext.xml": `<beans xmlns:jaxrs="http://cxf.apache.org/jaxrs">
  <jaxrs:server id="clubRs" address="http://localhost:8034/test">
    <jaxrs:serviceBeans><ref bean="clubRepository"/></jaxrs:serviceBeans>
  </jaxrs:server>
  <bean id="clubRepository" class="com.example.league.impl.ClubRepositoryImpl"/>
</beans>
`,
  "match-ws/src/main/java/com/example/league/ws/MatchServiceImpl.java": `package com.example.league.ws;

public class MatchServiceImpl implements MatchServicePort {
    public String getKickoff(String matchId) { return null; }
}
`,
  "match-ws/src/main/resources/META-INF/wsdl/MatchService.wsdl": `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="MatchService" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="http://example.com/league">
  <wsdl:message name="getKickoff"><wsdl:part name="matchId" type="xsd:string"/></wsdl:message>
  <wsdl:portType name="MatchServicePort">
    <wsdl:operation name="getKickoff"><wsdl:input message="tns:getKickoff"/></wsdl:operation>
  </wsdl:portType>
</wsdl:definitions>
`,
  "match-ws/src/main/resources/match-context.xml": `<beans xmlns:jaxws="http://cxf.apache.org/jaxws">
  <bean id="matchService" class="com.example.league.ws.MatchServiceImpl" />
  <jaxws:endpoint id="matchEndpoint" implementor="#matchService"
      wsdlLocation="META-INF/wsdl/MatchService.wsdl"
      address="http://\${server.hostname}:\${server.port.soap}/MatchService">
  </jaxws:endpoint>
</beans>
`,
};

describe("CXF endpoint addresses", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cxf-addresses-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] => summary.routeMap.map((r) => `${r.httpMethod ?? "-"} ${r.path}`).sort();

  it("serves a Blueprint jaxrs:server's interface under its address; placeholder and test addresses state nothing", () => {
    expect(rows()).toEqual(expect.arrayContaining([
      "GET /club-service/repository/v1/clubs",
      "GET /club-service/repository/v1/clubs/{clubId}",
    ]));
    expect(rows().filter((r) => r.includes("/v1/clubs"))).toHaveLength(2);
  });

  it("serves a jaxws:endpoint implementor's WSDL operations under the address path after its host", () => {
    expect(rows()).toContain("- /MatchService/getKickoff");
  });
});

describe("cxfAddressPath", () => {
  it("keeps a relative path or the path after a known host, never a placeholder path", () => {
    expect(cxfAddressPath("/club-service/repository/")).toBe("/club-service/repository");
    expect(cxfAddressPath("http://${host}:${port.soap}/MatchService")).toBe("/MatchService");
    expect(cxfAddressPath("http://localhost:8034")).toBe("");
    expect(cxfAddressPath("http://${host}:${port}${servicename}")).toBeNull();
    expect(cxfAddressPath("/${servicename}")).toBeNull();
  });
});
