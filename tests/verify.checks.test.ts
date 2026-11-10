import { describe, expect, it } from "vitest";
import { AcceptanceCheckSchema, describeCheck, isPublicHttpsUrl, runCheck } from "../src/verify/checks.js";

const page = (status: number, body = "", headers: Record<string, string> = {}) => async () => new Response(body, { status, headers });
const HEX = "a".repeat(64);

describe("isPublicHttpsUrl", () => {
  it("accepts public https pages only", () => {
    expect(isPublicHttpsUrl("https://example.com/post")).toBe(true);
    expect(isPublicHttpsUrl("http://example.com")).toBe(false);
    expect(isPublicHttpsUrl("https://localhost/x")).toBe(false);
    expect(isPublicHttpsUrl("https://10.0.0.5/admin")).toBe(false);
    expect(isPublicHttpsUrl("https://169.254.169.254/latest")).toBe(false);
    expect(isPublicHttpsUrl("https://[::1]/")).toBe(false);
    expect(isPublicHttpsUrl("https://user:pw@example.com")).toBe(false);
    expect(isPublicHttpsUrl("https://intranet/")).toBe(false);
  });
});

describe("runCheck", () => {
  it("passes a page that contains the text, and fails one that does not", async () => {
    const c = AcceptanceCheckSchema.parse({ kind: "url_contains", url: "https://example.com/launch", text: "Now live" });
    expect((await runCheck(c, undefined, page(200, "<h1>Now live</h1>"))).passed).toBe(true);
    const miss = await runCheck(c, undefined, page(200, "coming soon"));
    expect(miss).toMatchObject({ passed: false, detail: 'https://example.com/launch does not contain "Now live"' });
  });

  it("never fetches a private address, and does not follow redirects", async () => {
    let called = false;
    const spy = async () => ((called = true), new Response("Now live"));
    const inside = await runCheck({ kind: "url_contains", url: "https://192.168.1.1/", text: "x" }, undefined, spy);
    expect(inside.passed).toBe(false);
    expect(called).toBe(false);
    const moved = await runCheck({ kind: "url_contains", url: "https://example.com/", text: "x" }, undefined, page(302, "", { location: "https://10.0.0.1/" }));
    expect(moved).toMatchObject({ passed: false });
    expect(moved.detail).toContain("redirects");
  });

  it("checks a GitHub pull request is merged", async () => {
    const c = AcceptanceCheckSchema.parse({ kind: "github_pr_merged", repo: "angelraph/clausehold", pr: 21 });
    expect((await runCheck(c, undefined, page(200, JSON.stringify({ merged: true, merged_at: "2026-11-10T10:00:00Z" })))).passed).toBe(true);
    expect((await runCheck(c, undefined, page(200, JSON.stringify({ merged: false, state: "open" })))).detail).toBe("Pull request #21 is open, not merged");
    expect((await runCheck(c, undefined, page(404))).passed).toBe(false);
  });

  it("compares the delivered hash for an agreed file", async () => {
    const c = AcceptanceCheckSchema.parse({ kind: "sha256", value: HEX });
    expect((await runCheck(c, `sha256:${HEX}`)).passed).toBe(true);
    expect((await runCheck(c, `sha256:${"b".repeat(64)}`)).passed).toBe(false);
    expect((await runCheck(c, undefined)).passed).toBe(false);
  });

  it("fails, never throws, when the check cannot run", async () => {
    const broken = async () => {
      throw new Error("network down");
    };
    const v = await runCheck({ kind: "url_contains", url: "https://example.com/", text: "x" }, undefined, broken);
    expect(v).toMatchObject({ passed: false });
    expect(v.detail).toContain("network down");
  });
});

describe("AcceptanceCheckSchema", () => {
  it("rejects malformed checks and describes good ones", () => {
    expect(AcceptanceCheckSchema.safeParse({ kind: "sha256", value: "xyz" }).success).toBe(false);
    expect(AcceptanceCheckSchema.safeParse({ kind: "github_pr_merged", repo: "not a repo", pr: 1 }).success).toBe(false);
    expect(describeCheck({ kind: "github_pr_merged", repo: "a/b", pr: 3 })).toBe("github.com/a/b pull request #3 must be merged");
  });
});
