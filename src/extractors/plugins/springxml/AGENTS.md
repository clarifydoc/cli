# Spring XML plugin

Reads `.xml` files through the regex path: Spring bean files, MyBatis mapper XML, `AndroidManifest.xml`, Liquibase changelogs, ORM mappings and WSDL-as-XML. It owns the `.xml` extension; `preprocess` admits a file by its root.

- Spring beans: the tag scanner keeps a prefix off the tag's `name` (`XmlTag.qname` has it as written), so `<beans:bean id="clubService" class="…"/>` is a bean; `preprocess` admits a file whose `beans`/`bean` carry a prefix, and a `jaxrs:server` is told by its written name.
- REST client proxies ([client-proxies.ts](client-proxies.ts)): a Spring XML factory bean or `<jaxrs:client>` is an `HttpClientRegistration` with `proxyOf` (the fully qualified API interface); core turns every call on a receiver of that type into a `contract` call (see [java-kotlin](../java-kotlin/AGENTS.md)).
- Android: the plugin admits an `AndroidManifest.xml` (`shared/android-manifest.ts`: an `android-manifest` fact plus a `<manifest>` function); [java-kotlin/android-manifest-components.ts](../java-kotlin/android-manifest-components.ts) links it to the classes it names.
- MyBatis ([mybatis.ts](mybatis.ts), [mybatis-dispatch.ts](mybatis-dispatch.ts)): a mapper method is joined to its `<select|insert|update|delete>` statement in the mapper XML, whose SQL names the tables; the statement's SQL goes through the shared SQL reader (`joinedTableRows` for the further sources, `sqlAccessRow` per access).
- Framework rule `spring-webflow` lives here (cross-cutting rules live with the plugin that owns the file format).
