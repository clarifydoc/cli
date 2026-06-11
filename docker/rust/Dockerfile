FROM rust:1.96.0-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates && \
    curl -fsSL https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-unknown-linux-gnu.gz \
      | gunzip > /usr/local/bin/rust-analyzer && \
    chmod +x /usr/local/bin/rust-analyzer && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
# Use absolute path: the rust:slim image puts rustup proxies first on PATH,
# and the proxy fails because the toolchain doesn't ship rust-analyzer here.
ENTRYPOINT ["/usr/local/bin/rust-analyzer"]
