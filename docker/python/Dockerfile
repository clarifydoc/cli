FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm i -g pyright && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENTRYPOINT ["pyright-langserver", "--stdio"]
