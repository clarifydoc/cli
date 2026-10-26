import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

const WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" name="ILeague" targetNamespace="urn:league">
  <message name="GetClub0Request"><part name="id" type="xs:int"/></message>
  <message name="GetClub0Response"><part name="return" type="xs:string"/></message>
  <portType name="ILeague">
    <operation name="GetClub"><input message="tns:GetClub0Request"/><output message="tns:GetClub0Response"/></operation>
  </portType>
  <binding name="ILeaguebinding" type="tns:ILeague">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetClub"><soap:operation soapAction="urn:league#GetClub" style="rpc"/></operation>
  </binding>
  <service name="ILeagueservice">
    <port name="ILeaguePort" binding="tns:ILeaguebinding"><soap:address location="http://localhost:8080/soap/ILeague"/></port>
  </service>
</definitions>
`;

describe("a WSDL contract saved as .xml", () => {
  it("is read as a WSDL: its operations are rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-wsdl-xml-"));
    try {
      await mkdir(join(dir, "app/soap"), { recursive: true });
      await writeFile(join(dir, "app/soap/ILeague.xml"), WSDL);
      await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
      const summary = await loadReportSummary(join(dir, "out"));
      expect((summary.routeMap ?? []).some((r) => /GetClub/.test(`${r.path} ${r.handler}`))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
