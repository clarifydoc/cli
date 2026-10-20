import { describe, it, expect } from "vitest";
import { entryFileOf, parseDockerfile, type RepoFiles } from "./dockerfiles.js";

const repo = (files: Record<string, string>): RepoFiles => ({ exists: (p) => p in files, read: (p) => files[p] });

describe("Dockerfiles", () => {
  it("reads the final stage: its command, env and ports, carried over from the stage it is built from", () => {
    expect(parseDockerfile(`
# build
FROM node:20 AS build
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN npm ci && \\
    npm run build
FROM build AS runtime
ENV PORT=8080 ORDERS_URL="http://orders:8080"
ENV LEGACY_MODE on
EXPOSE 8080/tcp 9090
CMD ["node", "dist/server.js"]
`)).toEqual({ command: "node dist/server.js", env: { NODE_ENV: "production", PORT: "8080", ORDERS_URL: "http://orders:8080", LEGACY_MODE: "on" }, expose: [8080, 9090], workdir: "/app" });
    expect(parseDockerfile(`FROM python:3.12\nENTRYPOINT ["gunicorn"]\nCMD ["shop.wsgi:application", "-b", "0.0.0.0:8000"]`).command).toBe("gunicorn shop.wsgi:application -b 0.0.0.0:8000");
    expect(parseDockerfile(`FROM mcr.microsoft.com/dotnet/aspnet:8.0\nENTRYPOINT dotnet Orders.Api.dll`).command).toBe("dotnet Orders.Api.dll");
  });

  it("resolves the command to the source file it starts", () => {
    const files = repo({
      "api/app/main.py": "", "api/app/worker/__main__.py": "", "web/src/server.ts": "", "web/package.json": JSON.stringify({ scripts: { start: "node dist/server.js" } }),
      "jobs/run.sh": "", "shop/wsgi.py": "",
    });
    expect(entryFileOf("python app/main.py", "api", files)).toBe("api/app/main.py");
    expect(entryFileOf("uvicorn app.main:app --host 0.0.0.0", "api", files)).toBe("api/app/main.py");
    expect(entryFileOf("python -m app.worker", "api", files)).toBe("api/app/worker/__main__.py");
    expect(entryFileOf("node /app/dist/server.js", "web", files)).toBe("web/src/server.ts");
    expect(entryFileOf("npm start", "web", files)).toBe("web/src/server.ts");
    expect(entryFileOf("sh -c ./run.sh", "jobs", files)).toBe("jobs/run.sh");
    expect(entryFileOf("gunicorn shop.wsgi:application -b 0.0.0.0:8000", "", files)).toBe("shop/wsgi.py");
    expect(entryFileOf("dotnet Orders.Api.dll", "orders", files)).toBeUndefined();
    expect(entryFileOf("python ../escape.py", "api", files)).toBeUndefined();
  });
});
