import { describe, expect, it, vi } from "vitest";

import { displayUrlExpiresInSeconds, storageKeyOf, toStorageRef } from "../lib/storage-ref";
import { storageRefsForUrls } from "../lib/storage-sign";
import { displayUrlForFile } from "../vault/lib/display-url";
import { serializeMessage } from "./mapping";
import { resolveDocsStoredMedia, resolveStoredMedia, UNAVAILABLE_ATTACHMENT_TEXT, UNAVAILABLE_TOOL_STORAGE_URL } from "./stored-media";

const ORIGIN = "http://localhost:8788";
const ORIGINS = [ORIGIN];

describe("storage references", () => {
    it("reads a key from a reference and from any URL this origin issued", () => {
        expect(storageKeyOf(toStorageRef("agent-files/abc"), ORIGINS)).toBe("agent-files/abc");
        expect(storageKeyOf(`${ORIGIN}/agent-files/abc?exp=1&method=GET&bucket=default&sig=x`, ORIGINS)).toBe("agent-files/abc");
        expect(storageKeyOf(`${ORIGIN}/c6a6cf78-8d65-4181-8e49-9d155e10b38f`, ORIGINS)).toBe("c6a6cf78-8d65-4181-8e49-9d155e10b38f");
    });

    it("does not mistake other paths on this origin for storage", () => {
        expect(storageKeyOf(`${ORIGIN}/api/v1/openapi.json`, ORIGINS)).toBeNull();
        // A bare `?sig=` is not a storage URL — anyone can append one to any path.
        expect(storageKeyOf(`${ORIGIN}/api/v1/openapi.json?sig=x`, ORIGINS)).toBeNull();
    });

    it("ignores foreign URLs, text, and traversal", () => {
        expect(storageKeyOf("https://fal.media/files/cat.png", ORIGINS)).toBeNull();
        expect(storageKeyOf("just some text", ORIGINS)).toBeNull();
        expect(storageKeyOf(toStorageRef("../secrets"), ORIGINS)).toBeNull();
        expect(storageKeyOf(toStorageRef(""), ORIGINS)).toBeNull();
        expect(storageKeyOf(42, ORIGINS)).toBeNull();
    });

    it("gives query results a stable expiry within a window, valid 12-18 hours", () => {
        const start = Date.UTC(2026, 8, 23, 0, 30);
        const first = displayUrlExpiresInSeconds(start);
        const later = displayUrlExpiresInSeconds(start + 60 * 60 * 1000);

        // Same absolute expiry → identical signed URLs across re-runs.
        expect(start / 1000 + first).toBe(start / 1000 + 3600 + later);
        expect(first).toBeGreaterThanOrEqual(12 * 3600);
        expect(first).toBeLessThanOrEqual(18 * 3600);
    });
});

describe("resolveStoredMedia", () => {
    const signer = () => {
        let calls = 0;

        return vi.fn(async (key: string) => {
            calls += 1;

            return `${ORIGIN}/${key}?sig=fresh-${String(calls)}`;
        });
    };

    it("signs an attached user image persisted as a reference", async () => {
        const sign = signer();
        const message = {
            content: [
                { text: "look", type: "text" },
                { image: toStorageRef("agent-files/a"), type: "image" },
            ],
            role: "user",
        };
        const resolved = await resolveStoredMedia(message, { allowedKeys: new Set(["agent-files/a"]), origins: ORIGINS, sign, toolKeys: new Set() });

        expect(resolved.content).toEqual([
            { text: "look", type: "text" },
            { image: `${ORIGIN}/agent-files/a?sig=fresh-1`, type: "image" },
        ]);
        // The persisted message is untouched: it keeps the reference.
        expect(message.content[1]).toEqual({ image: toStorageRef("agent-files/a"), type: "image" });
    });

    it("replaces a user part naming storage the message does not own", async () => {
        const sign = signer();
        const resolved = await resolveStoredMedia(
            { content: [{ image: toStorageRef("agent-files/victim"), type: "image" }], role: "user" },
            { allowedKeys: new Set(), origins: ORIGINS, sign, toolKeys: new Set() },
        );

        expect(resolved.content).toEqual([{ text: UNAVAILABLE_ATTACHMENT_TEXT, type: "text" }]);
        expect(sign).not.toHaveBeenCalled();
    });

    it("never rewrites text, even a reference typed by the user", async () => {
        const sign = signer();
        const message = { content: [{ text: toStorageRef("agent-files/victim"), type: "text" }], role: "user" };

        expect(await resolveStoredMedia(message, { allowedKeys: new Set(), origins: ORIGINS, sign, toolKeys: new Set() })).toBe(message);
        expect(sign).not.toHaveBeenCalled();
    });

    it("re-signs expired URLs in tool results and assistant files, leaving foreign URLs", async () => {
        const sign = signer();
        const resolved = await resolveStoredMedia(
            {
                content: [
                    {
                        output: {
                            type: "json",
                            value: { cdn: "https://fal.media/x.png", imageUrl: `${ORIGIN}/agent-files/gen?exp=1&method=GET&bucket=default&sig=old` },
                        },
                        toolCallId: "t1",
                        toolName: "generateImage",
                        type: "tool-result",
                    },
                    { data: `${ORIGIN}/agent-files/gen?exp=1&method=GET&bucket=default&sig=old`, mediaType: "image/png", type: "file" },
                ],
                role: "tool",
            },
            { allowedKeys: new Set(), origins: ORIGINS, sign, toolKeys: new Set(["agent-files/gen"]) },
        );

        expect(resolved.content).toEqual([
            {
                output: { type: "json", value: { cdn: "https://fal.media/x.png", imageUrl: `${ORIGIN}/agent-files/gen?sig=fresh-1` } },
                toolCallId: "t1",
                toolName: "generateImage",
                type: "tool-result",
            },
            { data: `${ORIGIN}/agent-files/gen?sig=fresh-1`, mediaType: "image/png", type: "file" },
        ]);
        expect(sign).toHaveBeenCalledTimes(1);
    });

    it("gives a follow-up turn a FRESH URL for an attachment from an earlier turn", async () => {
        const sign = signer();
        const docs = [{ fileIds: ["f1"], message: { content: [{ image: toStorageRef("agent-files/a"), type: "image" }], role: "user" } }];
        const lookupKeys = vi.fn(async () => new Map([["f1", "agent-files/a"]]));

        // Two context builds — the first turn and a follow-up — over the same stored row.
        const [firstTurn] = await resolveDocsStoredMedia(docs, { lookupKeys, lookupOwnedKeys: async () => new Set(), origins: ORIGINS, sign });
        const [followUp] = await resolveDocsStoredMedia(docs, { lookupKeys, lookupOwnedKeys: async () => new Set(), origins: ORIGINS, sign });

        const urlOf = (doc: typeof firstTurn) => (doc!.message!.content as { image: string }[])[0]!.image;

        expect(urlOf(firstTurn)).toBe(`${ORIGIN}/agent-files/a?sig=fresh-1`);
        expect(urlOf(followUp)).toBe(`${ORIGIN}/agent-files/a?sig=fresh-2`);
        expect((docs[0]!.message.content as { image: string }[])[0]!.image).toBe(toStorageRef("agent-files/a"));
    });

    it("re-signs a legacy URL-only user part when the key belongs to the message", async () => {
        const sign = signer();
        const [doc] = await resolveDocsStoredMedia(
            [
                {
                    fileIds: ["f1"],
                    message: { content: [{ image: `${ORIGIN}/agent-files/a?exp=1&method=GET&bucket=default&sig=expired`, type: "image" }], role: "user" },
                },
            ],
            { lookupKeys: async () => new Map([["f1", "agent-files/a"]]), lookupOwnedKeys: async () => new Set(), origins: ORIGINS, sign },
        );

        expect((doc!.message!.content as { image: string }[])[0]!.image).toBe(`${ORIGIN}/agent-files/a?sig=fresh-1`);
    });
});

describe("vault display URLs", () => {
    it("signs by key, keeps foreign URLs, drops our own unsigned ones", async () => {
        vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);

        const getSignedUrl = vi.fn(async (key: string) => `${ORIGIN}/${key}?sig=s`);

        expect(await displayUrlForFile({ getSignedUrl }, { key: "k1", url: "https://files.example/k1" })).toBe(`${ORIGIN}/k1?sig=s`);
        expect(await displayUrlForFile({ getSignedUrl }, { url: "https://fal.media/x.png" })).toBe("https://fal.media/x.png");
        expect(await displayUrlForFile({ getSignedUrl }, {})).toBeUndefined();

        vi.unstubAllEnvs();
    });
});

describe("tool-generated media", () => {
    const signed = `${ORIGIN}/agent-files/${"a".repeat(64)}?exp=1&method=GET&bucket=default&sig=abc`;
    const ref = toStorageRef(`agent-files/${"a".repeat(64)}`);

    it("persists signed storage URLs in tool output as references, leaving everything else", () => {
        expect(storageRefsForUrls({ images: [{ model: "m", url: signed }], other: `${ORIGIN}/api/v1/x`, remote: "https://fal.media/x.png" }, ORIGINS)).toEqual({
            images: [{ model: "m", url: ref }],
            other: `${ORIGIN}/api/v1/x`,
            remote: "https://fal.media/x.png",
        });
    });

    it("stores a tool result with the key, and a later read (model or UI) gets a live URL", async () => {
        vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);

        try {
            const { message } = await serializeMessage({} as never, {
                content: [{ output: { type: "json", value: { images: [{ url: signed }] } }, toolCallId: "t1", toolName: "generateImage", type: "tool-result" }],
                role: "tool",
            });
            const stored = message.content as { output: { value: { images: { url: string }[] } } }[];

            expect(stored[0]!.output.value.images[0]!.url).toBe(ref);

            // The follow-up turn's context builder, and the share page's query, both go through this.
            const lookupOwnedKeys = vi.fn(async (_userId: string, keys: string[]) => new Set(keys));
            const [read] = await resolveDocsStoredMedia([{ message, userId: "owner" }], {
                lookupKeys: async () => new Map(),
                lookupOwnedKeys,
                origins: ORIGINS,
                sign: async (key) => `${ORIGIN}/${key}?sig=fresh`,
            });
            const resolved = read!.message!.content as { output: { value: { images: { url: string }[] } } }[];

            expect(resolved[0]!.output.value.images[0]!.url).toBe(`${ORIGIN}/agent-files/${"a".repeat(64)}?sig=fresh`);
            expect(lookupOwnedKeys).toHaveBeenCalledWith("owner", [`agent-files/${"a".repeat(64)}`]);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("never signs storage a tool result names that the message's owner does not own", async () => {
        const mine = `agent-files/${"a".repeat(64)}`;
        const victim = `agent-files/${"c".repeat(64)}`;
        const sign = vi.fn(async (key: string) => `${ORIGIN}/${key}?sig=fresh`);
        // What a fetched page or an MCP server could hand back: someone else's key, as a reference and as a URL.
        const message = {
            content: [
                {
                    output: {
                        type: "json",
                        value: {
                            mine: toStorageRef(mine),
                            planted: toStorageRef(victim),
                            plantedUrl: `${ORIGIN}/${victim}?exp=1&method=GET&bucket=default&sig=x`,
                        },
                    },
                    toolCallId: "t1",
                    toolName: "fetchUrl",
                    type: "tool-result",
                },
            ],
            role: "tool",
        };

        const [read] = await resolveDocsStoredMedia([{ message, userId: "owner" }], {
            lookupKeys: async () => new Map(),
            lookupOwnedKeys: async (_userId, keys) => new Set(keys.filter((key) => key === mine)),
            origins: ORIGINS,
            sign,
        });

        expect((read!.message!.content as { output: { value: unknown } }[])[0]!.output.value).toEqual({
            mine: `${ORIGIN}/${mine}?sig=fresh`,
            planted: UNAVAILABLE_TOOL_STORAGE_URL,
            plantedUrl: UNAVAILABLE_TOOL_STORAGE_URL,
        });
        expect(sign).toHaveBeenCalledTimes(1);

        // No owner on the row: nothing in its tool results is signed.
        const [ownerless] = await resolveDocsStoredMedia([{ message }], {
            lookupKeys: async () => new Map(),
            lookupOwnedKeys: async (_userId, keys) => new Set(keys),
            origins: ORIGINS,
            sign,
        });

        expect((ownerless!.message!.content as { output: { value: { mine: string } } }[])[0]!.output.value.mine).toBe(UNAVAILABLE_TOOL_STORAGE_URL);
    });
});
