FROM eclipse-temurin:21-alpine
RUN apk add --no-cache curl unzip && \
    mkdir -p /opt/kotlin-ls && \
    curl -fSL "https://github.com/fwcd/kotlin-language-server/releases/latest/download/server.zip" \
      -o /tmp/kls.zip && \
    unzip /tmp/kls.zip -d /opt/kotlin-ls && \
    rm /tmp/kls.zip && \
    chmod +x /opt/kotlin-ls/server/bin/kotlin-language-server
ENV PATH="/opt/kotlin-ls/server/bin:$PATH"
WORKDIR /workspace
ENTRYPOINT ["kotlin-language-server"]
