# pascal-language-server (pasls) by genericptr, built from source.
# Uses the repo's own build_fpc.sh — no lazbuild/IDE packages needed.
# Tracks the same Lazarus branch (lazarus_4_0) as the upstream CI.

FROM debian:bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      fpc git ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

ARG PLS_REF=trunk
ARG LAZARUS_REF=lazarus_4_0

RUN git clone --depth 1 --branch ${PLS_REF} \
      https://github.com/genericptr/pascal-language-server.git /build/pls \
 && git clone --depth 1 --branch ${LAZARUS_REF} \
      https://gitlab.com/freepascal.org/lazarus/lazarus.git /build/lazarus

RUN cd /build/pls/src \
 && chmod +x build_fpc.sh \
 && LAZARUSDIR=/build/lazarus ./build_fpc.sh \
 && mkdir -p /out \
 && cp /build/pls/dist/*/pasls /out/pasls \
 && strip /out/pasls

# ─── Runtime stage ────────────────────────────────────────────────────────
# fpc is kept at runtime so CodeTools can resolve RTL/SysUtils unit paths
# from a real FPC install. Without it, goto-definition works for in-project
# symbols only — unit-qualified lookups fail.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends fpc \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/pasls /usr/local/bin/pasls

WORKDIR /workspace
ENTRYPOINT ["pasls"]
