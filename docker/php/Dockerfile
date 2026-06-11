FROM php:8.5.6-cli
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates nodejs npm && \
    npm i -g intelephense && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENTRYPOINT ["intelephense", "--stdio"]
