import { createHash } from "node:crypto";
import OpenAI from "openai";
import { config } from "../config.js";

/**
 * A NEAR AI Cloud note that explains a delivery in plain words, for the
 * buyer and the public receipt. It is a witness, not a judge: release is
 * decided by the clause's rule (the worker key delivered before the
 * deadline), never by this text. Only the note's hash goes on chain.
 */

const SYSTEM_PROMPT = `You write a short, neutral note for a payment receipt.
You are told the terms of a job and what the worker says they delivered.
Describe in at most three plain sentences what was delivered and how it relates to the terms.
You do not decide whether anyone is paid. Never say the payment should or should not be released.
Never invent details that are not in the input. If the delivery description is empty, say only that the worker submitted the delivery hash shown.`;

export interface DeliveryInput {
  terms: string;
  deliveryHash: string;
  /** What the worker says they delivered. Optional. */
  description?: string;
}

export interface DeliveryNote {
  note: string;
  /** sha256 hex of the note text, suitable for the clause's note_hash. */
  noteHash: string;
  model: string;
}

export type ChatClient = Pick<OpenAI, "chat">;

export function hashNote(note: string): string {
  return createHash("sha256").update(note, "utf-8").digest("hex");
}

/** Returns null when NEAR AI Cloud is not configured: the note is optional and nothing depends on it. */
export async function writeDeliveryNote(input: DeliveryInput, client?: ChatClient, model = config.nearAi.model): Promise<DeliveryNote | null> {
  if (!client) {
    if (!config.nearAi.apiKey || !model) return null;
    client = new OpenAI({ apiKey: config.nearAi.apiKey, baseURL: config.nearAi.baseUrl });
  }
  if (!model) return null;

  const user = [`Terms: ${input.terms}`, `Delivery hash: ${input.deliveryHash}`, `Worker's description: ${input.description?.trim() || "(none)"}`].join("\n");
  const response = await client.chat.completions.create({
    model,
    max_tokens: 200,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
  });
  const note = response.choices[0]?.message?.content?.trim();
  if (!note) return null;
  const bounded = note.slice(0, 600);
  return { note: bounded, noteHash: hashNote(bounded), model };
}
