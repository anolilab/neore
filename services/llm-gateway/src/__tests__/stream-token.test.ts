import { describe, expect, it } from "vitest";

import { createStreamToken, verifyStreamToken } from "../lib/stream-token.js";

const SECRET = "test-signing-secret-32-bytes-long";

describe("stream-token", () => {
    describe("createStreamToken", () => {
        it("creates a token with 5 colon-separated parts", async () => {
            const token = await createStreamToken("stream1", "user1", "thread1", SECRET);
            const parts = token.split(":");

            expect(parts).toHaveLength(5);
        });

        it("includes streamId, userId, threadId in the token", async () => {
            const token = await createStreamToken("stream-abc", "user-xyz", "thread-def", SECRET);
            const [streamId, userId, threadId] = token.split(":", 3);

            expect(streamId).toBe("stream-abc");
            expect(userId).toBe("user-xyz");
            expect(threadId).toBe("thread-def");
        });

        it("sets expiry ~30 minutes in the future", async () => {
            const before = Date.now();
            const token = await createStreamToken("s", "u", "t", SECRET);
            const after = Date.now();
            const expiresAt = Number(token.split(":", 4)[3]);

            expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 100);
            expect(expiresAt).toBeLessThanOrEqual(after + 30 * 60 * 1000 + 100);
        });

        it("throws if streamId contains a colon", async () => {
            await expect(createStreamToken("stream:bad", "user1", "thread1", SECRET)).rejects.toThrow('Stream token field "streamId" must not contain ":"');
        });

        it("throws if userId contains a colon", async () => {
            await expect(createStreamToken("stream1", "user:bad", "thread1", SECRET)).rejects.toThrow('Stream token field "userId" must not contain ":"');
        });

        it("throws if threadId contains a colon", async () => {
            await expect(createStreamToken("stream1", "user1", "thread:bad", SECRET)).rejects.toThrow('Stream token field "threadId" must not contain ":"');
        });

        it("produces different tokens for different inputs", async () => {
            const token1 = await createStreamToken("stream1", "user1", "thread1", SECRET);
            const token2 = await createStreamToken("stream2", "user1", "thread1", SECRET);

            expect(token1).not.toBe(token2);
        });
    });

    describe("verifyStreamToken", () => {
        it("verifies a valid token and returns payload", async () => {
            const token = await createStreamToken("stream1", "user1", "thread1", SECRET);
            const payload = await verifyStreamToken(token, SECRET);

            expect(payload).toEqual({
                streamId: "stream1",
                threadId: "thread1",
                userId: "user1",
            });
        });

        it("throws on expired token", async () => {
            // Manually construct an expired token
            const expiredAt = (Date.now() - 1000).toString();
            const message = `stream1\nuser1\nthread1\n${expiredAt}`;
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
            const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
            const hmac = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
            const token = `stream1:user1:thread1:${expiredAt}:${hmac}`;

            await expect(verifyStreamToken(token, SECRET)).rejects.toThrow("Stream token expired");
        });

        it("throws on tampered signature", async () => {
            const token = await createStreamToken("stream1", "user1", "thread1", SECRET);
            const parts = token.split(":");

            // Replace the last part (hmac) with garbage
            parts[4] = "a".repeat(64);
            const tampered = parts.join(":");

            await expect(verifyStreamToken(tampered, SECRET)).rejects.toThrow("Invalid stream token signature");
        });

        it("throws on wrong secret", async () => {
            const token = await createStreamToken("stream1", "user1", "thread1", SECRET);

            await expect(verifyStreamToken(token, "wrong-secret")).rejects.toThrow("Invalid stream token signature");
        });

        it("throws on malformed token (wrong part count)", async () => {
            await expect(verifyStreamToken("only:four:parts:here", SECRET)).rejects.toThrow("Invalid stream token format");
        });

        it("throws on token with too many parts", async () => {
            await expect(verifyStreamToken("a:b:c:d:e:f", SECRET)).rejects.toThrow("Invalid stream token format");
        });
    });
});
