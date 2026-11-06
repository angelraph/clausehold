/**
 * A minimal Upstash Redis REST client: one command per HTTP call, no SDK.
 * Works in serverless functions, where nothing on local disk survives
 * between requests.
 */
export class UpstashError extends Error {
  constructor(message: string) {
    super(`Upstash: ${message}`);
    this.name = "UpstashError";
  }
}

export interface RedisLike {
  command<T = unknown>(args: Array<string | number>): Promise<T>;
}

export class UpstashRedis implements RedisLike {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async command<T = unknown>(args: Array<string | number>): Promise<T> {
    const res = await this.fetchImpl(this.url.replace(/\/$/, ""), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new UpstashError(body.error ?? `HTTP ${res.status}`);
    return body.result as T;
  }
}
