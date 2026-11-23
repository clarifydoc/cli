FROM mcr.microsoft.com/dotnet/sdk:10.0
ARG ROSLYN_VERSION=plusvb-1.0.0
# TARGETARCH is set by BuildKit; the server must match the image's platform.
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN case "${TARGETARCH}" in \
      amd64) ROSLYN_RID=linux-x64 ;; \
      arm64) ROSLYN_RID=linux-arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH:-unset} (need amd64 or arm64; build with BuildKit)" >&2; exit 1 ;; \
    esac && \
    mkdir -p /opt/roslyn && \
    curl -fSL "https://github.com/misterkiem/roslyn-plusvb/releases/download/${ROSLYN_VERSION}/microsoft.codeanalysis.languageserver.${ROSLYN_RID}.zip" \
      -o /tmp/roslyn.zip && \
    unzip -q /tmp/roslyn.zip -d /opt/roslyn && \
    rm /tmp/roslyn.zip
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
