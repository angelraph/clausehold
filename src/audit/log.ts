import { createHash } from "node:crypto";
import { FileLogBackend, type LogBackend } from "../storage/backends.js";
import { defaultLogBackend } from "../storage/index.js";

export type AuditEventType =
  | "MANDATE_CREATED"
  | "MANDATE_UPDATED"
  | "CLAUSE_PROPOSED"
  | "VERDICT_ISSUED"
  | "CLAUSE_REFUSED"
  | "CLAUSE_CLEARED"
  | "INVITE_OPENED"
  | "INVITE_KEY_BOUND"
  | "CLAUSE_CREATED"
  | "CLAUSE_FUNDING_QUOTED"
  | "CLAUSE_FUNDED"
  | "CLAUSE_DELIVERED"
  | "CLAUSE_RELEASED"
  | "CLAUSE_RETURNED"
  | "CLAUSE_FROZEN"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_EXPIRED"
  | "KILL_SWITCH_ENGAGED"
  | "KILL_SWITCH_RELEASED"
  | "AGENT_REGISTERED"
  | "AGENT_REVOKED";

export interface AuditEntry {
  seq: number;
  timestamp: string;
  type: AuditEventType;
  /** The NEAR network the event concerns, or "n/a" for off-chain events. */
  network: "testnet" | "mainnet" | "n/a";
  payload: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = "GENESIS";

function hashEntry(e: Omit<AuditEntry, "hash">): string {
  const canonical = JSON.stringify({
    seq: e.seq,
    timestamp: e.timestamp,
    type: e.type,
    network: e.network,
    payload: e.payload,
    prevHash: e.prevHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Append-only, hash-chained audit log. Every entry's hash depends on the
 * previous entry's hash, so tampering with an earlier entry breaks the
 * chain from that point on, which `verify()` detects. Entries live in a
 * file on a machine, or in Upstash Redis on a serverless host.
 */
export class AuditLog {
  private backendInstance?: LogBackend;

  /** A file path (as before), a backend, or nothing for the configured default. */
  constructor(private readonly target?: string | LogBackend) {}

  private get backend(): LogBackend {
    if (!this.backendInstance) {
      this.backendInstance = typeof this.target === "string" ? new FileLogBackend(this.target) : (this.target ?? defaultLogBackend());
    }
    return this.backendInstance;
  }

  private async readAll(): Promise<AuditEntry[]> {
    return (await this.backend.readAll()).map((line) => JSON.parse(line) as AuditEntry);
  }

  async append(type: AuditEventType, network: AuditEntry["network"], payload: unknown): Promise<AuditEntry> {
    // Optimistic: build the next entry from the current tail and append it only
    // if nobody else appended in between. Otherwise re-read and try again.
    for (let attempt = 0; attempt < 8; attempt++) {
      const entries = await this.readAll();
      const last = entries[entries.length - 1];
      const seq = last ? last.seq + 1 : 0;
      const prevHash = last ? last.hash : GENESIS;
      const withoutHash = { seq, timestamp: new Date().toISOString(), type, network, payload, prevHash };
      const entry: AuditEntry = { ...withoutHash, hash: hashEntry(withoutHash) };
      if (await this.backend.appendIfLength(entries.length, JSON.stringify(entry))) return entry;
    }
    throw new Error("Audit log is under heavy concurrent writes; could not append after 8 attempts");
  }

  async tail(n = 20): Promise<AuditEntry[]> {
    return (await this.readAll()).slice(-n);
  }

  async all(): Promise<AuditEntry[]> {
    return this.readAll();
  }

  /** Verifies the hash chain end to end. Returns the first break, if any. */
  async verify(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number; reason: string }> {
    const entries = await this.readAll();
    let expectedPrevHash = GENESIS;
    for (const entry of entries) {
      if (entry.prevHash !== expectedPrevHash) {
        return { ok: false, brokenAtSeq: entry.seq, reason: `prevHash mismatch: expected ${expectedPrevHash}, got ${entry.prevHash}` };
      }
      const recomputed = hashEntry({
        seq: entry.seq,
        timestamp: entry.timestamp,
        type: entry.type,
        network: entry.network,
        payload: entry.payload,
        prevHash: entry.prevHash,
      });
      if (recomputed !== entry.hash) {
        return { ok: false, brokenAtSeq: entry.seq, reason: `hash mismatch: entry content does not match its recorded hash` };
      }
      expectedPrevHash = entry.hash;
    }
    return { ok: true };
  }
}

export const auditLog = new AuditLog();
