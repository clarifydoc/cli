import { describe, it, expect } from "vitest";
import { extractSpringClientProxies } from "./client-proxies.js";

const proxies = (xml: string) => extractSpringClientProxies(xml.split("\n")).map(({ line: _l, ...r }) => r);

describe("Spring XML client proxies", () => {
  it("reads a factory bean handed an API type and a URL property", () => {
    expect(proxies(`<beans>
    <bean id="personApi" class="com.acme.EosRestClientFactory" factory-method="create">
        <constructor-arg><value type="java.lang.Class">com.acme.api.PersonApi</value></constructor-arg>
        <constructor-arg><value type="java.lang.String">\${person.service.url}</value></constructor-arg>
    </bean>
    <bean id="orders" class="com.acme.ClientFactory" factory-method="create">
        <constructor-arg type="java.lang.Class" value="com.acme.api.OrdersApi"/>
        <constructor-arg value="\${orders.url:http://localhost:8081}"/>
    </bean>
</beans>`)).toEqual([
      { client: "com.acme.api.PersonApi", scope: "project", proxyOf: "com.acme.api.PersonApi", base: { kind: "config", key: "person.service.url" } },
      { client: "com.acme.api.OrdersApi", scope: "project", proxyOf: "com.acme.api.OrdersApi", base: { kind: "config", key: "orders.url", fallback: "http://localhost:8081" } },
    ]);
  });

  it("reads CXF clients: <jaxrs:client> and a JAXRSClientFactoryBean", () => {
    expect(proxies(`<beans>
  <jaxrs:client id="docs" serviceClass="com.acme.api.DocumentApi" address="http://earchive:8080/api"/>
  <bean class="org.apache.cxf.jaxrs.client.JAXRSClientFactoryBean">
    <property name="serviceClass" value="com.acme.api.LinkApi"/>
    <property name="address" value="\${link.registry.url}"/>
  </bean>
</beans>`)).toEqual([
      { client: "com.acme.api.DocumentApi", scope: "project", proxyOf: "com.acme.api.DocumentApi", base: { kind: "literal", key: "http://earchive:8080/api" } },
      { client: "com.acme.api.LinkApi", scope: "project", proxyOf: "com.acme.api.LinkApi", base: { kind: "config", key: "link.registry.url" } },
    ]);
  });

  it("reads nothing into a factory with no address, or one handed two types", () => {
    expect(proxies(`<beans>
  <bean id="mapper" class="com.acme.MapperFactory" factory-method="create">
    <constructor-arg><value type="java.lang.Class">com.acme.domain.Person</value></constructor-arg>
    <constructor-arg><value type="java.lang.String">\${mapper.mode}</value></constructor-arg>
  </bean>
  <bean id="conv" class="com.acme.ConverterFactory" factory-method="create">
    <constructor-arg><value type="java.lang.Class">com.acme.A</value></constructor-arg>
    <constructor-arg><value type="java.lang.Class">com.acme.B</value></constructor-arg>
    <constructor-arg><value>\${conv.url}</value></constructor-arg>
  </bean>
</beans>`)).toEqual([]);
  });
});
