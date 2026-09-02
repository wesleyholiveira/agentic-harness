import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export type RedisReply = string | number | Buffer | null | RedisReply[];

export class RedisResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisResponseError";
  }
}

interface ParsedReply {
  value: RedisReply | RedisResponseError;
  nextOffset: number;
}

function lineEnd(buffer: Buffer, offset: number): number {
  return buffer.indexOf("\r\n", offset, "utf8");
}

export function parseRedisReply(buffer: Buffer, offset = 0): ParsedReply | null {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset] ?? 0);
  if (prefix === "+" || prefix === "-" || prefix === ":") {
    const end = lineEnd(buffer, offset + 1);
    if (end < 0) return null;
    const text = buffer.toString("utf8", offset + 1, end);
    const nextOffset = end + 2;
    if (prefix === "+") return { value: text, nextOffset };
    if (prefix === "-") return { value: new RedisResponseError(text), nextOffset };
    const number = Number(text);
    if (!Number.isSafeInteger(number)) throw new Error(`redis_integer_invalid:${text}`);
    return { value: number, nextOffset };
  }
  if (prefix === "$" || prefix === "*") {
    const end = lineEnd(buffer, offset + 1);
    if (end < 0) return null;
    const lengthText = buffer.toString("utf8", offset + 1, end);
    const length = Number(lengthText);
    if (!Number.isInteger(length) || length < -1) throw new Error(`redis_length_invalid:${lengthText}`);
    let cursor = end + 2;
    if (length === -1) return { value: null, nextOffset: cursor };
    if (prefix === "$") {
      if (buffer.length < cursor + length + 2) return null;
      if (buffer[cursor + length] !== 13 || buffer[cursor + length + 1] !== 10) {
        throw new Error("redis_bulk_terminator_invalid");
      }
      return { value: buffer.subarray(cursor, cursor + length), nextOffset: cursor + length + 2 };
    }
    const values: RedisReply[] = [];
    for (let index = 0; index < length; index++) {
      const parsed = parseRedisReply(buffer, cursor);
      if (!parsed) return null;
      if (parsed.value instanceof RedisResponseError) throw parsed.value;
      values.push(parsed.value);
      cursor = parsed.nextOffset;
    }
    return { value: values, nextOffset: cursor };
  }
  throw new Error(`redis_reply_prefix_unsupported:${prefix}`);
}

function encodeCommand(parts: Array<string | Buffer>): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`, "utf8")];
  for (const part of parts) {
    const value = Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8");
    chunks.push(Buffer.from(`$${value.length}\r\n`, "utf8"), value, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(chunks);
}

interface PendingCommand {
  resolve(value: RedisReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RedisRespClientOptions {
  url: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export interface RedisCommandClient {
  command(parts: Array<string | Buffer>): Promise<RedisReply>;
  close(): Promise<void>;
  redactedUrl(): string;
}

export class RedisRespClient implements RedisCommandClient {
  private readonly parsedUrl: URL;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private socket: Socket | TLSSocket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: PendingCommand[] = [];
  private readyPromise: Promise<void> | undefined;
  private ready = false;
  private closing = false;

  constructor(options: RedisRespClientOptions) {
    this.parsedUrl = new URL(options.url);
    if (!new Set(["redis:", "rediss:"]).has(this.parsedUrl.protocol)) {
      throw new Error(`semantic_redis_protocol_invalid:${this.parsedUrl.protocol}`);
    }
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  }

  redactedUrl(): string {
    const copy = new URL(this.parsedUrl.toString());
    if (copy.username) copy.username = "***";
    if (copy.password) copy.password = "***";
    return copy.toString();
  }

  async command(parts: Array<string | Buffer>): Promise<RedisReply> {
    if (this.closing) throw new Error("redis_client_closing");
    if (parts.length === 0) throw new Error("redis_command_empty");
    await this.ensureReady();
    return this.sendConnected(parts);
  }

  private async ensureReady(): Promise<void> {
    if (this.ready && this.socket && !this.socket.destroyed) return;
    if (!this.readyPromise) {
      this.readyPromise = this.open().finally(() => {
        this.readyPromise = undefined;
      });
    }
    await this.readyPromise;
  }

  private async open(): Promise<void> {
    if (this.closing) throw new Error("redis_client_closing");
    const port = Number(this.parsedUrl.port || (this.parsedUrl.protocol === "rediss:" ? 6380 : 6379));
    const host = this.parsedUrl.hostname;
    if (!host || !Number.isInteger(port) || port <= 0) throw new Error("semantic_redis_endpoint_invalid");

    const socket = this.parsedUrl.protocol === "rediss:"
      ? tlsConnect({ host, port, servername: host })
      : createConnection({ host, port });
    this.socket = socket;
    this.ready = false;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.onClosed(new Error("semantic_redis_connection_closed")));
    socket.on("error", (error) => {
      if (!socket.destroyed) socket.destroy(error);
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`semantic_redis_connect_timeout:${this.connectTimeoutMs}`));
      }, this.connectTimeoutMs);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      socket.once(this.parsedUrl.protocol === "rediss:" ? "secureConnect" : "connect", () => finish(resolve));
      socket.once("error", (error) => finish(() => reject(error)));
    });

    try {
      const password = decodeURIComponent(this.parsedUrl.password);
      const username = decodeURIComponent(this.parsedUrl.username);
      if (password) await this.sendConnected(username ? ["AUTH", username, password] : ["AUTH", password]);
      const database = this.parsedUrl.pathname.replace(/^\//, "");
      if (database) {
        const parsed = Number(database);
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`semantic_redis_database_invalid:${database}`);
        if (parsed !== 0) await this.sendConnected(["SELECT", String(parsed)]);
      }
      this.ready = true;
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private sendConnected(parts: Array<string | Buffer>): Promise<RedisReply> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("semantic_redis_not_connected"));
    return new Promise<RedisReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy(new Error(`semantic_redis_command_timeout:${this.commandTimeoutMs}:${String(parts[0] ?? "unknown")}`));
      }, this.commandTimeoutMs);
      this.pending.push({ resolve, reject, timer });
      socket.write(encodeCommand(parts), (error) => {
        if (error) this.destroy(error);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (this.pending.length > 0) {
      let parsed: ParsedReply | null;
      try {
        parsed = parseRedisReply(this.buffer, offset);
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!parsed) break;
      const pending = this.pending.shift();
      if (!pending) break;
      clearTimeout(pending.timer);
      if (parsed.value instanceof RedisResponseError) pending.reject(parsed.value);
      else pending.resolve(parsed.value);
      offset = parsed.nextOffset;
    }
    if (offset > 0) this.buffer = this.buffer.subarray(offset);
  }

  private onClosed(error: Error): void {
    this.ready = false;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    const pending = this.pending.splice(0);
    for (const command of pending) {
      clearTimeout(command.timer);
      command.reject(error);
    }
  }

  private destroy(error: Error): void {
    const socket = this.socket;
    if (socket && !socket.destroyed) socket.destroy(error);
    this.onClosed(error);
  }

  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    try {
      await Promise.race([this.sendConnected(["QUIT"]), new Promise((resolve) => setTimeout(resolve, 500))]);
    } catch {
      // Best-effort shutdown; Redis is reconstructible.
    }
    await new Promise<void>((resolve) => {
      if (socket.destroyed) return resolve();
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }
}
