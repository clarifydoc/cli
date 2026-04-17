FROM golang:1.25-alpine
RUN go install golang.org/x/tools/gopls@latest
WORKDIR /workspace
ENTRYPOINT ["gopls", "serve"]
