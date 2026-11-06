import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({ config: { nearAi: { apiKey: undefined, baseUrl: "https://example.invalid/v1", model: undefined } } }));

import { hashNote, writeDeliveryNote, type ChatClient } from "../src/witness/nearai.js";

function fakeClient(content: string | undefined) {
  const create = vi.fn(async () => ({ choices: [{ message: { content } }] }));
  return { client: { chat: { completions: { create } } } as unknown as ChatClient, create };
}

describe("writeDeliveryNote", () => {
  it("returns null when NEAR AI Cloud is not configured, so nothing depends on it", async () => {
    expect(await writeDeliveryNote({ terms: "t", deliveryHash: "h" })).toBeNull();
  });

  it("writes a note and hashes exactly the text it returns", async () => {
    const { client, create } = fakeClient("  The editor delivered a 30 second cut.  ");
    const note = await writeDeliveryNote({ terms: "Cut to 30s", deliveryHash: "sha256:abc", description: "30s cut" }, client, "some-model");
    expect(note).toEqual({ note: "The editor delivered a 30 second cut.", noteHash: hashNote("The editor delivered a 30 second cut."), model: "some-model" });
    const call = (create.mock.calls[0] as unknown as [{ messages: Array<{ role: string; content: string }> }])[0];
    expect(call.messages[0]!.content).toMatch(/do not decide whether anyone is paid/);
    expect(call.messages[1]!.content).toContain("sha256:abc");
  });

  it("caps the note length", async () => {
    const { client } = fakeClient("x".repeat(5000));
    const note = await writeDeliveryNote({ terms: "t", deliveryHash: "h" }, client, "m");
    expect(note!.note).toHaveLength(600);
  });

  it("returns null on an empty model reply", async () => {
    const { client } = fakeClient(undefined);
    expect(await writeDeliveryNote({ terms: "t", deliveryHash: "h" }, client, "m")).toBeNull();
  });
});
