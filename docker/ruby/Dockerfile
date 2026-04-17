FROM ruby:3.3-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential && \
    gem install solargraph && \
    apt-get purge -y build-essential && apt-get autoremove -y && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENTRYPOINT ["solargraph", "stdio"]
