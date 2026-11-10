/**
 * Acceptance checks: a test the buyer writes down when opening the job, which
 * the desk runs against every delivery before it relays it.
 *
 *   url_contains      a public https page must contain a piece of text (the site is live, the post is up)
 *   github_pr_merged  a pull request on GitHub must be merged (the fix landed)
 *   sha256            the delivery must be exactly this file (an agreed artefact)
 *
 * What it does and does not promise: the desk refuses to relay a delivery
 * that fails its check, so with the hosted desk a failing delivery is never
 * paid. The contract itself only checks who delivered. A worker could relay
 * a failing delivery elsewhere, which is why a buyer who wants a hard stop
 * also sets a review window: then the failed check is shown and the buyer can
 * freeze the clause, and the DAO co-signer decides.
 */
import { z } from "zod";

export const AcceptanceCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url_contains"), url: z.string().url().max(500), text: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("github_pr_merged"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"), pr: z.number().int().positive() }),
  z.object({ kind: z.literal("sha256"), value: z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters") }),
]);

export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export interface CheckVerdict {
  passed: boolean;
  detail: string;
  checkedAt: string;
}

export function describeCheck(c: AcceptanceCheck): string {
  if (c.kind === "url_contains") return `${c.url} must contain "${c.text}"`;
  if (c.kind === "github_pr_merged") return `github.com/${c.repo} pull request #${c.pr} must be merged`;
  return `the delivery must have SHA-256 ${c.value.slice(0, 12)}…`;
}

/** Hosts the desk will never fetch: loopback, private and link-local ranges, and bare IPs. */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  return host.includes(".");
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_BYTES = 1_000_000;

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.length;
    chunks.push(value);
    if (size >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Runs a check. `deliveryHash` is what the worker signed ("sha256:<hex>"),
 * needed only for the sha256 kind. Never throws: a check that cannot run fails.
 */
export async function runCheck(c: AcceptanceCheck, deliveryHash: string | undefined, fetcher: Fetcher = fetch, now = new Date()): Promise<CheckVerdict> {
  const at = now.toISOString();
  const verdict = (passed: boolean, detail: string): CheckVerdict => ({ passed, detail, checkedAt: at });
  try {
    if (c.kind === "sha256") {
      const got = (deliveryHash ?? "").replace(/^sha256:/, "").toLowerCase();
      if (!got) return verdict(false, "No delivery yet to compare");
      return got === c.value ? verdict(true, "The delivery is exactly the agreed file") : verdict(false, `The delivery's SHA-256 is ${got.slice(0, 12)}…, not ${c.value.slice(0, 12)}…`);
    }
    const signal = AbortSignal.timeout(8000);
    if (c.kind === "url_contains") {
      if (!isPublicHttpsUrl(c.url)) return verdict(false, "Only public https addresses can be checked");
      const res = await fetcher(c.url, { redirect: "manual", signal, headers: { "user-agent": "clausehold-acceptance-check" } });
      if (res.status >= 300 && res.status < 400) return verdict(false, `${c.url} redirects (${res.status}); give the final address`);
      if (!res.ok) return verdict(false, `${c.url} answered ${res.status}`);
      const body = await readCapped(res);
      return body.includes(c.text) ? verdict(true, `${c.url} contains "${c.text}"`) : verdict(false, `${c.url} does not contain "${c.text}"`);
    }
    const res = await fetcher(`https://api.github.com/repos/${c.repo}/pulls/${c.pr}`, {
      signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "clausehold-acceptance-check" },
    });
    if (res.status === 404) return verdict(false, `github.com/${c.repo} has no pull request #${c.pr}`);
    if (!res.ok) return verdict(false, `GitHub answered ${res.status}`);
    const pr = (await res.json()) as { merged?: boolean; state?: string; merged_at?: string | null };
    return pr.merged ? verdict(true, `Pull request #${c.pr} was merged ${pr.merged_at ?? ""}`.trim()) : verdict(false, `Pull request #${c.pr} is ${pr.state ?? "open"}, not merged`);
  } catch (err) {
    return verdict(false, `The check could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}
