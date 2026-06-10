FROM eclipse-temurin:21-alpine
ARG JDTLS_VERSION=1.58.0
ARG JDTLS_TIMESTAMP=202604151538
RUN apk add --no-cache python3 curl unzip && \
    mkdir -p /opt/jdtls && \
    curl -fSL "https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/jdt-language-server-${JDTLS_VERSION}-${JDTLS_TIMESTAMP}.tar.gz" \
      -o /tmp/jdtls.tar.gz && \
    tar xzf /tmp/jdtls.tar.gz -C /opt/jdtls && \
    rm /tmp/jdtls.tar.gz && \
    # Stable symlink so the entrypoint doesn't depend on the (per-release) launcher version.
    ln -s "$(ls /opt/jdtls/plugins/org.eclipse.equinox.launcher_*.jar | head -n1)" /opt/jdtls/launcher.jar
ENV JDTLS_HOME=/opt/jdtls
WORKDIR /workspace
ENTRYPOINT ["java", \
  "-Declipse.application=org.eclipse.jdt.ls.core.id1", \
  "-Dosgi.bundles.defaultStartLevel=4", \
  "-Declipse.product=org.eclipse.jdt.ls.core.product", \
  "-Dlog.level=ERROR", \
  "-Xms256m", \
  "-Xmx2G", \
  "-XX:+UseG1GC", \
  "-XX:+UseStringDeduplication", \
  "-XX:GCTimeRatio=4", \
  "-XX:AdaptiveSizePolicyWeight=90", \
  "-Dsun.zip.disableMemoryMapping=true", \
  "--add-modules=ALL-SYSTEM", \
  "--add-opens", "java.base/java.util=ALL-UNNAMED", \
  "--add-opens", "java.base/java.lang=ALL-UNNAMED", \
  "-jar", "/opt/jdtls/launcher.jar", \
  "-configuration", "/opt/jdtls/config_linux", \
  "-data", "/tmp/jdtls-workspace"]
