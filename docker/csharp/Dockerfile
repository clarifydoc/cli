FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine
RUN apk add --no-cache curl unzip && \
    mkdir -p /opt/omnisharp && \
    curl -fSL "https://github.com/OmniSharp/omnisharp-roslyn/releases/latest/download/omnisharp-linux-musl-x64-net6.0.tar.gz" \
      -o /tmp/omnisharp.tar.gz && \
    tar xzf /tmp/omnisharp.tar.gz -C /opt/omnisharp && \
    rm /tmp/omnisharp.tar.gz && \
    chmod +x /opt/omnisharp/OmniSharp
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
