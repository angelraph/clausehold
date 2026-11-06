import { config } from "../config.js";
import { FileKvBackend, FileLogBackend, RedisKvBackend, RedisLogBackend, type KvBackend, type LogBackend } from "./backends.js";
import { UpstashRedis } from "./upstash.js";

/** Upstash when its URL and token are set (as on Vercel), files otherwise. */
export function storageKind(): "upstash" | "files" {
  return config.storage?.upstashUrl && config.storage?.upstashToken ? "upstash" : "files";
}

let redis: UpstashRedis | undefined;
function client(): UpstashRedis {
  redis ??= new UpstashRedis(config.storage.upstashUrl!, config.storage.upstashToken!);
  return redis;
}

export function defaultLogBackend(): LogBackend {
  return storageKind() === "upstash" ? new RedisLogBackend(client(), `${config.storage.prefix}:audit`) : new FileLogBackend(config.auditLogPath);
}

export function defaultKvBackend(): KvBackend {
  return storageKind() === "upstash" ? new RedisKvBackend(client(), `${config.storage.prefix}:kv`) : new FileKvBackend(config.mandatesDir);
}
