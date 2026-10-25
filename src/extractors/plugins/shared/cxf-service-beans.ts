/**
 * The classes and interfaces an Apache CXF JAX-RS server serves, as a route
 * fact: registered in Java (`JAXRSServerFactoryBean.setServiceBeans(…)`) or in
 * Spring XML (`<jaxrs:server><jaxrs:serviceBeans>`). The Java/Kotlin plugin's
 * resolver turns each implementing class's operations into contract rows.
 */
export const CXF_SERVICE_BEANS_FACT = "cxf:service-beans";

export interface ServiceBeanFact {
  /** Declared types of the registered beans, fully qualified where the file says so. */
  types: string[];
}

/**
 * The address one CXF endpoint is published at (`<jaxrs:server address>`,
 * `<jaxws:endpoint address>`, in Spring or OSGi Blueprint XML) and the types it
 * serves: the routes those types declare are served under that path.
 */
export const CXF_SERVER_ADDRESS_FACT = "cxf:server-address";

export interface ServerAddressFact {
  /** The address's path, normalized (`/club-service/repository`; `""` for the root). */
  path: string;
  /** Types served there: bean classes, Blueprint service interfaces, a JAX-WS implementor. */
  types: string[];
}

/**
 * The path of a CXF `address` attribute, or null when it cannot be known: a
 * relative address is the path; an absolute one keeps what follows its host and
 * port; a placeholder in the path (`${rest.servicename}`), or one glued to the
 * port, leaves it unknown.
 */
export function cxfAddressPath(address: string): string | null {
  let rest = address.trim();
  const abs = /^[a-z][\w+.-]*:\/\/([^/]*)(.*)$/i.exec(rest);
  if (abs) {
    if (!/^(?:\$\{[^}]*\}|[\w.-]+)(?::(?:\$\{[^}]*\}|\d+))?$/.test(abs[1]!)) return null;
    rest = abs[2]!;
  }
  if (rest.includes("${") || /[?#\s]/.test(rest)) return null;
  if (rest && !rest.startsWith("/")) return null;
  return rest.replace(/\/+$/, "");
}
