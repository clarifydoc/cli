FROM node:24-alpine
RUN npm i -g typescript-language-server typescript
WORKDIR /workspace
ENTRYPOINT ["typescript-language-server", "--stdio"]
