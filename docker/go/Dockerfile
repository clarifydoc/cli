FROM golang:1.26.4-alpine
RUN go install golang.org/x/tools/gopls@latest
WORKDIR /workspace
ENTRYPOINT ["gopls", "serve"]
