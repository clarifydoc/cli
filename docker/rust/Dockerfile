FROM rust:1.96.0-slim
# TARGETARCH is set by BuildKit; the binary must match the image's platform.
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) RA_TARGET=x86_64-unknown-linux-gnu ;; \
      arm64) RA_TARGET=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported architecture: ${TARGETARCH:-unset} (need amd64 or arm64; build with BuildKit)" >&2; exit 1 ;; \
    esac && \
    apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates && \
    curl -fsSL "https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-${RA_TARGET}.gz" \
      | gunzip > /usr/local/bin/rust-analyzer && \
    chmod +x /usr/local/bin/rust-analyzer && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
# Use absolute path: the rust:slim image puts rustup proxies first on PATH,
# and the proxy fails because the toolchain doesn't ship rust-analyzer here.
ENTRYPOINT ["/usr/local/bin/rust-analyzer"]
