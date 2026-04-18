FROM mcr.microsoft.com/dotnet/sdk:10.0
ARG ROSLYN_VERSION=plusvb-1.0.0
ARG ROSLYN_ASSET=microsoft.codeanalysis.languageserver.linux-x64.zip
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/roslyn && \
    curl -fSL "https://github.com/misterkiem/roslyn-plusvb/releases/download/${ROSLYN_VERSION}/${ROSLYN_ASSET}" \
      -o /tmp/roslyn.zip && \
    unzip -q /tmp/roslyn.zip -d /opt/roslyn && \
    rm /tmp/roslyn.zip
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
