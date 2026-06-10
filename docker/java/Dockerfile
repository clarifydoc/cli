FROM eclipse-temurin:21-alpine
RUN apk add --no-cache python3 curl unzip && \
    mkdir -p /opt/jdtls && \
    curl -fSL "https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202409261450.tar.gz" \
      -o /tmp/jdtls.tar.gz && \
    tar xzf /tmp/jdtls.tar.gz -C /opt/jdtls && \
    rm /tmp/jdtls.tar.gz
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
  "-jar", "/opt/jdtls/plugins/org.eclipse.equinox.launcher_1.6.900.v20240613-2009.jar", \
  "-configuration", "/opt/jdtls/config_linux", \
  "-data", "/tmp/jdtls-workspace"]
