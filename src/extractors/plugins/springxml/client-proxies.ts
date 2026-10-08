import type { CallBaseRef, HttpClientRegistration } from "../../../types/analysis.js";

/**
 * REST client proxies declared in Spring XML — the way classic Spring
 * services reach each other. A proxy implements an API interface and turns
 * each method call into the HTTP request the interface's annotations declare:
 *
 *   <bean id="personApi" class="com.acme.RestClientFactory" factory-method="create">
 *     <constructor-arg><value type="java.lang.Class">com.acme.api.PersonApi</value></constructor-arg>
 *     <constructor-arg><value type="java.lang.String">${person.service.url}</value></constructor-arg>
 *   </bean>
 *   <jaxrs:client id="personApi" serviceClass="com.acme.api.PersonApi" address="${person.service.url}"/>
 *   <bean class="org.apache.cxf.jaxrs.client.JAXRSClientFactoryBean">
 *     <property name="serviceClass" value="com.acme.api.PersonApi"/> <property name="address" value="…"/>
 *   </bean>
 *
 * A factory bean counts when it is handed exactly ONE type (`java.lang.Class`)
 * and an address: an argument that is an http(s) URL, or a `${…}` property
 * named like one. Each becomes a registration keyed by that type.
 */

/** A property placeholder or literal as a base: `${a.url}` → config, `${a.url:http://x}` → with fallback. */
function baseOf(value: string): CallBaseRef | null {
  const v = value.trim();
  const ph = /^\$\{([^}:]+)(?::([^}]*))?\}$/.exec(v);
  if (ph) return { kind: "config", key: ph[1]!.trim(), ...(ph[2] && /^https?:\/\//i.test(ph[2]) ? { fallback: ph[2] } : {}) };
  return /^https?:\/\/\S+$/i.test(v) ? { kind: "literal", key: v } : null;
}

/** An argument that reads like an address: a URL, or a placeholder named like one. */
const ADDRESS_KEY = /(url|uri|address|endpoint|host|base)\b/i;
function isAddress(value: string): boolean {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return true;
  const ph = /^\$\{([^}:]+)/.exec(v);
  return !!ph && ADDRESS_KEY.test(ph[1]!.replace(/[._-]/g, " "));
}

const FQN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;

export function extractSpringClientProxies(lines: string[]): HttpClientRegistration[] {
  const source = lines.join("\n");
  if (!/java\.lang\.Class|serviceClass|jaxrs:client/.test(source)) return [];
  const out: HttpClientRegistration[] = [];
  const push = (type: string, address: string | undefined, index: number) => {
    const base = address ? baseOf(address) : null;
    out.push({ client: type, scope: "project", proxyOf: type, ...(base ? { base } : {}), line: lineAt(source, index) });
  };

  // <jaxrs:client serviceClass="…" address="…"/>
  for (const m of source.matchAll(/<jaxrs:client\b([^>]*)>/g)) {
    const cls = /\bserviceClass\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1];
    const addr = /\baddress\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1];
    if (cls && FQN.test(cls)) push(cls, addr, m.index!);
  }

  // <bean …> … </bean>: factory beans handed a type and an address.
  for (const m of source.matchAll(/<bean\b([^>]*?)(?:\/>|>([\s\S]*?)<\/bean>)/g)) {
    const attrs = m[1]!;
    const body = m[2] ?? "";
    const types: Array<{ value: string; index: number }> = [];
    const strings: string[] = [];
    const bodyStart = m.index! + m[0].indexOf(body);
    for (const v of body.matchAll(/<value\b([^>]*)>([^<]*)<\/value>/g)) {
      const type = /\btype\s*=\s*"([^"]+)"/.exec(v[1]!)?.[1];
      if (type === "java.lang.Class") types.push({ value: v[2]!.trim(), index: bodyStart + v.index! });
      else strings.push(v[2]!.trim());
    }
    for (const a of body.matchAll(/<(?:constructor-arg|property)\b([^>]*)\/?>/g)) {
      const value = /\bvalue\s*=\s*"([^"]+)"/.exec(a[1]!)?.[1];
      if (!value) continue;
      const name = /\bname\s*=\s*"([^"]+)"/.exec(a[1]!)?.[1];
      const type = /\btype\s*=\s*"([^"]+)"/.exec(a[1]!)?.[1];
      if (type === "java.lang.Class" || name === "serviceClass" || name === "resourceClass") types.push({ value: value.trim(), index: bodyStart + a.index! });
      else strings.push(value.trim());
    }
    const factory = /\bfactory-method\s*=\s*"/.test(attrs) || /ClientFactory|ProxyFactory|RestClient/i.test(attrs);
    const addresses = strings.filter(isAddress);
    if (!factory || types.length !== 1 || !FQN.test(types[0]!.value) || addresses.length === 0) continue;
    push(types[0]!.value, addresses[0], types[0]!.index);
  }
  return out;
}
