import type { Readable, Writable } from "stream";

/**
 * Minimal LSP types — we inline these to avoid requiring vscode-languageserver-protocol
 * as a dependency. These match the LSP 3.17 spec.
 */

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

interface InitializeParams {
  processId: number | null;
  rootUri: string;
  capabilities: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
}

interface ServerCapabilities {
  definitionProvider?: boolean | object;
  referencesProvider?: boolean | object;
}

interface InitializeResult {
  capabilities: ServerCapabilities;
}

// ─── JSON-RPC message types ───────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ─── LSP Client ───────────────────────────────────────────────────────────

export interface LspClientOptions {
  stdin: Writable;
  stdout: Readable;
  projectRoot: string;
  mountPath: string;
  initializationOptions?: Record<string, unknown>;
}

export interface DefinitionResult {
  uri: string;
  line: number;
  character: number;
}

export interface ReferenceResult {
  uri: string;
  line: number;
  character: number;
}

/**
 * A minimal LSP client that communicates over stdio using the LSP JSON-RPC protocol.
 * Designed to work with Docker containers where the server is running on the other end.
 */
export class LspClient {
  private stdin: Writable;
  private stdout: Readable;
  private projectRoot: string;
  private mountPath: string;
  private initOptions?: Record<string, unknown>;

  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private contentLength = -1;

  private hasDefinition = false;
  private hasReferences = false;
  private closed = false;

  constructor(options: LspClientOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.projectRoot = options.projectRoot;
    this.mountPath = options.mountPath;
    this.initOptions = options.initializationOptions;

    this.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.stdout.on("end", () => this.onClose());
    this.stdout.on("error", () => this.onClose());
  }

  /**
   * Initialize the LSP server. Must be called before any other requests.
   */
  async initialize(): Promise<void> {
    const rootUri = `file://${this.mountPath}`;

    const params: InitializeParams = {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          synchronization: {
            didOpen: true,
            didClose: true,
          },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      initializationOptions: this.initOptions,
    };

    const result = await this.sendRequest("initialize", params, 60000) as InitializeResult;

    this.hasDefinition = !!result.capabilities.definitionProvider;
    this.hasReferences = !!result.capabilities.referencesProvider;

    // Send initialized notification
    this.sendNotification("initialized", {});
  }

  /**
   * Notify the server that a document has been opened.
   */
  openDocument(filePath: string, languageId: string, text: string): void {
    const uri = this.toContainerUri(filePath);
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
  }

  /**
   * Notify the server that a document has been closed.
   */
  closeDocument(filePath: string): void {
    const uri = this.toContainerUri(filePath);
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  /**
   * Get the definition location(s) for a symbol at the given position.
   */
  async getDefinition(filePath: string, line: number, character: number): Promise<DefinitionResult[]> {
    if (!this.hasDefinition) return [];

    const uri = this.toContainerUri(filePath);
    const result = await this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    }, 5000);

    return this.parseLocations(result);
  }

  /**
   * Get all references to a symbol at the given position.
   */
  async getReferences(filePath: string, line: number, character: number): Promise<ReferenceResult[]> {
    if (!this.hasReferences) return [];

    const uri = this.toContainerUri(filePath);
    const result = await this.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: false },
    }, 10000);

    return this.parseLocations(result);
  }

  /**
   * Check if the server supports definition queries.
   */
  get supportsDefinition(): boolean {
    return this.hasDefinition;
  }

  /**
   * Check if the server supports reference queries.
   */
  get supportsReferences(): boolean {
    return this.hasReferences;
  }

  /**
   * Shut down the LSP server gracefully.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await this.sendRequest("shutdown", null, 3000);
      this.sendNotification("exit", null);
    } catch {
      // Server may have already exited
    }
    this.closed = true;
    this.rejectAllPending("LSP client shut down");
  }

  // ─── Path mapping ─────────────────────────────────────────────────────

  /**
   * Convert a host file path to a container file:// URI.
   * Host: C:/_excluded/project/src/foo.ts → Container: file:///workspace/src/foo.ts
   */
  private toContainerUri(hostPath: string): string {
    // Normalize to forward slashes
    let normalized = hostPath.replace(/\\/g, "/");

    // Normalize project root for comparison
    let normalizedRoot = this.projectRoot.replace(/\\/g, "/");
    if (!normalizedRoot.endsWith("/")) normalizedRoot += "/";

    // If the path is relative (no drive letter, no leading slash), prefix with project root
    if (!normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized)) {
      normalized = normalizedRoot + normalized;
    }

    // Strip project root prefix, replace with mount path
    if (normalized.startsWith(normalizedRoot)) {
      const relative = normalized.slice(normalizedRoot.length);
      return `file://${this.mountPath}/${relative}`;
    }

    // Fallback: just use the mount path + filename
    const fileName = normalized.split("/").pop() ?? normalized;
    return `file://${this.mountPath}/${fileName}`;
  }

  /**
   * Convert a container file:// URI back to a host-relative path.
   * Container: file:///workspace/src/foo.ts → Host relative: src/foo.ts
   */
  toHostPath(containerUri: string): string | null {
    const prefix = `file://${this.mountPath}/`;
    if (!containerUri.startsWith(prefix)) return null;
    return containerUri.slice(prefix.length);
  }

  // ─── JSON-RPC protocol ────────────────────────────────────────────────

  private sendRequest(method: string, params: unknown, timeout = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("LSP client is closed"));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const message: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? undefined,
      };

      this.writeMessage(message);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (this.closed) return;

    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params: params ?? undefined,
    };

    this.writeMessage(message);
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    try {
      this.stdin.write(header + body);
    } catch {
      // Stream may be closed
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    this.processBuffer();
  }

  private processBuffer(): void {
    while (true) {
      if (this.contentLength === -1) {
        // Look for Content-Length header
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1]!, 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;

      const body = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(body) as JsonRpcResponse;
        this.onMessage(message);
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private onMessage(message: JsonRpcResponse): void {
    if (message.id == null) return; // Notification from server — ignore

    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private onClose(): void {
    this.closed = true;
    this.rejectAllPending("LSP connection closed");
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }

  // ─── Location parsing ─────────────────────────────────────────────────

  private parseLocations(result: unknown): DefinitionResult[] {
    if (!result) return [];

    // Result can be Location, Location[], LocationLink, or LocationLink[]
    const items = Array.isArray(result) ? result : [result];
    const locations: DefinitionResult[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const loc = item as (LspLocation | LspLocationLink);

      // LocationLink
      if ("targetUri" in loc) {
        const hostPath = this.toHostPath(loc.targetUri);
        if (hostPath) {
          locations.push({
            uri: hostPath,
            line: loc.targetSelectionRange.start.line,
            character: loc.targetSelectionRange.start.character,
          });
        }
        continue;
      }

      // Location
      if ("uri" in loc && "range" in loc) {
        const hostPath = this.toHostPath(loc.uri);
        if (hostPath) {
          locations.push({
            uri: hostPath,
            line: loc.range.start.line,
            character: loc.range.start.character,
          });
        }
      }
    }

    return locations;
  }
}
