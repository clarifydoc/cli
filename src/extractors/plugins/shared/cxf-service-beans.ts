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
