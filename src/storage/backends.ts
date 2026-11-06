import { existsSync, mkdirSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RedisLike } from "./upstash.js";

/**
 * Where the desk keeps its records. Two backends behind one interface:
 * plain files for running on a machine, Upstash Redis for serverless hosts,
 * where local files do not survive between requests.
 */

/** An append-only list of JSON lines with an atomic "append only if it is next" step. */
export interface LogBackend {
  readAll(): Promise<string[]>;
  /** Appends `line` only if the log currently has exactly `expectedLength` lines. */
  appendIfLength(expectedLength: number, line: string): Promise<boolean>;
}

export interface KvBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class FileLogBackend implements LogBackend {
  constructor(private readonly filePath: string) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async readAll(): Promise<string[]> {
    if (!existsSync(this.filePath)) return [];
    const content = await readFile(this.filePath, "utf-8");
    return content.split("\n").filter((l) => l.trim().length > 0);
  }

  async appendIfLength(expectedLength: number, line: string): Promise<boolean> {
    if ((await this.readAll()).length !== expectedLength) return false;
    // Single-writer append with fsync so a crash mid-write cannot corrupt earlier lines.
    const fh = await open(this.filePath, "a");
    try {
      await fh.appendFile(line + "\n", "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  }
}

export class FileKvBackend implements KvBackend {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.file(key), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    await writeFile(this.file(key), value, "utf-8");
  }
}

/**
 * Appends only when the list length matches, in one atomic Lua step, so two
 * serverless instances writing at once cannot both claim the same position
 * and fork the hash chain. The loser re-reads and retries.
 */
const APPEND_IF_LENGTH = "if redis.call('LLEN', KEYS[1]) == tonumber(ARGV[1]) then redis.call('RPUSH', KEYS[1], ARGV[2]) return 1 else return 0 end";

export class RedisLogBackend implements LogBackend {
  constructor(
    private readonly redis: RedisLike,
    private readonly key: string
  ) {}

  async readAll(): Promise<string[]> {
    return (await this.redis.command<string[]>(["LRANGE", this.key, 0, -1])) ?? [];
  }

  async appendIfLength(expectedLength: number, line: string): Promise<boolean> {
    const r = await this.redis.command<number>(["EVAL", APPEND_IF_LENGTH, 1, this.key, expectedLength, line]);
    return Number(r) === 1;
  }
}

export class RedisKvBackend implements KvBackend {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string
  ) {}

  async get(key: string): Promise<string | null> {
    return (await this.redis.command<string | null>(["GET", `${this.prefix}:${key}`])) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.redis.command(["SET", `${this.prefix}:${key}`, value]);
  }
}
