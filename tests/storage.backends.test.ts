import { describe, it, expect, vi } from "vitest";
import { AuditLog } from "../src/audit/log.js";
import { RedisKvBackend, RedisLogBackend } from "../src/storage/backends.js";
import { UpstashRedis, type RedisLike } from "../src/storage/upstash.js";

/** An in-memory stand-in for Redis that implements the few commands the backends use. */
class FakeRedis implements RedisLike {
  lists = new Map<string, string[]>();
  kv = new Map<string, string>();
  /** When set, an extra line is pushed just before the next conditional append, to simulate a racing writer. */
  raceWith: string | null = null;

  async command<T>(args: Array<string | number>): Promise<T> {
    const [cmd, ...rest] = args.map(String);
    switch (cmd) {
      case "LRANGE":
        return [...(this.lists.get(rest[0]!) ?? [])] as T;
      case "EVAL": {
        const [, , key, expected, line] = rest;
        const list = this.lists.get(key!) ?? [];
        if (this.raceWith) {
          list.push(this.raceWith);
          this.raceWith = null;
        }
        this.lists.set(key!, list);
        if (list.length === Number(expected)) {
          list.push(line!);
          return 1 as T;
        }
        return 0 as T;
      }
      case "GET":
        return (this.kv.get(rest[0]!) ?? null) as T;
      case "SET":
        this.kv.set(rest[0]!, rest[1]!);
        return "OK" as T;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }
}

describe("audit log on Redis", () => {
  it("keeps the hash chain intact", async () => {
    const redis = new FakeRedis();
    const log = new AuditLog(new RedisLogBackend(redis, "t:audit"));
    await log.append("CLAUSE_PROPOSED", "testnet", { a: 1 });
    await log.append("CLAUSE_CLEARED", "testnet", { a: 2 });
    const all = await log.all();
    expect(all.map((e) => e.seq)).toEqual([0, 1]);
    expect(all[1]!.prevHash).toBe(all[0]!.hash);
    expect(await log.verify()).toEqual({ ok: true });
  });

  it("when another writer gets there first, retries on top of it instead of forking the chain", async () => {
    const redis = new FakeRedis();
    const backend = new RedisLogBackend(redis, "t:audit");
    const writerA = new AuditLog(backend);
    const writerB = new AuditLog(backend);
    const first = await writerA.append("CLAUSE_PROPOSED", "testnet", { by: "A" });

    // Writer A builds its next entry on seq 0, but writer B lands seq 1 first.
    const racing = { seq: 1, timestamp: new Date().toISOString(), type: "CLAUSE_PROPOSED", network: "testnet", payload: { by: "B" }, prevHash: first.hash };
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(JSON.stringify(racing)).digest("hex");
    redis.raceWith = JSON.stringify({ ...racing, hash });

    const mine = await writerA.append("CLAUSE_CLEARED", "testnet", { by: "A" });
    expect(mine.seq).toBe(2);
    expect(mine.prevHash).toBe(hash);
    expect(await writerB.verify()).toEqual({ ok: true });
  });

  it("detects tampering stored in Redis", async () => {
    const redis = new FakeRedis();
    const log = new AuditLog(new RedisLogBackend(redis, "t:audit"));
    await log.append("CLAUSE_PROPOSED", "testnet", { amount: 2 });
    await log.append("CLAUSE_CLEARED", "testnet", { amount: 2 });
    const list = redis.lists.get("t:audit")!;
    list[0] = list[0]!.replace('"amount":2', '"amount":200');
    expect((await log.verify()).ok).toBe(false);
  });
});

describe("key-value store on Redis", () => {
  it("prefixes keys so testnet and mainnet never share records", async () => {
    const redis = new FakeRedis();
    const testnet = new RedisKvBackend(redis, "clausehold:testnet:kv");
    const mainnet = new RedisKvBackend(redis, "clausehold:mainnet:kv");
    await testnet.set("m1", "T");
    expect(await testnet.get("m1")).toBe("T");
    expect(await mainnet.get("m1")).toBeNull();
  });
});

describe("UpstashRedis client", () => {
  it("sends one command as a JSON array with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "OK" }), { status: 200 }));
    const r = new UpstashRedis("https://example.upstash.io/", "tok", fetchImpl as unknown as typeof fetch);
    expect(await r.command(["SET", "k", 1])).toBe("OK");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.upstash.io");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual(["SET", "k", "1"]);
  });

  it("surfaces Upstash errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "WRONGTYPE" }), { status: 400 }));
    const r = new UpstashRedis("https://example.upstash.io", "tok", fetchImpl as unknown as typeof fetch);
    await expect(r.command(["GET", "k"])).rejects.toThrow(/WRONGTYPE/);
  });
});
