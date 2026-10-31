import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server-functions", () => {
    return { default: async () => "token-1" };
});
vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "https://backend.test" } };
});

const { sendHostMessage } = await import("./host-send");

const INPUT = { requestId: "r1", text: "fix it", threadId: "t1" };

const answering = (status: number, body: unknown) => vi.fn(async () => Response.json(body, { status }));

describe("sendHostMessage", () => {
    it("posts the prompt with the caller's bearer to the backend, and nowhere else", async () => {
        const fetcher = answering(200, { messageId: "m1", streamId: "s1", streamToken: "x" });

        await expect(sendHostMessage(INPUT, { fetch: fetcher as never })).resolves.toEqual({ ok: true });

        const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];

        expect(url.href).toBe("https://backend.test/hosts/send");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
        expect(JSON.parse(init.body as string)).toEqual(INPUT);
    });

    it("treats a repeat of an earlier request as sent", async () => {
        await expect(sendHostMessage(INPUT, { fetch: answering(200, { duplicate: true }) as never })).resolves.toEqual({ ok: true });
    });

    it("names why the backend refused, and calls anything else unreachable", async () => {
        await expect(sendHostMessage(INPUT, { fetch: answering(409, { error: "offline" }) as never })).resolves.toEqual({ error: "offline", ok: false });
        await expect(sendHostMessage(INPUT, { fetch: answering(409, { error: "turn_running" }) as never })).resolves.toEqual({
            error: "turn_running",
            ok: false,
        });
        await expect(sendHostMessage(INPUT, { fetch: answering(500, { error: "something new" }) as never })).resolves.toEqual({
            error: "unreachable",
            ok: false,
        });
        await expect(sendHostMessage(INPUT, { fetch: vi.fn(async () => new Response("<html>", { status: 502 })) as never })).resolves.toEqual({
            error: "unreachable",
            ok: false,
        });
        await expect(
            sendHostMessage(INPUT, {
                fetch: vi.fn(async () => {
                    throw new TypeError("network connection lost");
                }) as never,
            }),
        ).resolves.toEqual({ error: "unreachable", ok: false });
    });
});
