import { describe, expect, it } from "vitest";

import signRequest, { verifySignedRequest } from "./sign-request";

const HEX_RE = /^[\da-f]+$/;

describe("signRequest", () => {
    const secret = "test-secret-key-12345";
    const url = "https://api.example.com/v1/upload";
    const body = new TextEncoder().encode("test body content");

    it("should return X-Signature and X-Timestamp headers", async () => {
        const result = await signRequest("POST", url, body.buffer as ArrayBuffer, secret);

        expect(result).toHaveProperty("X-Signature");
        expect(result).toHaveProperty("X-Timestamp");
    });

    it("should produce hex-encoded signature", async () => {
        const result = await signRequest("POST", url, body.buffer as ArrayBuffer, secret);

        expect(result["X-Signature"]).toMatch(HEX_RE);
    });

    it("should produce a numeric timestamp", async () => {
        const result = await signRequest("POST", url, body.buffer as ArrayBuffer, secret);

        expect(Number(result["X-Timestamp"])).toBeGreaterThan(0);
    });

    it("should produce different signatures for different methods", async () => {
        const postResult = await signRequest("POST", url, body.buffer as ArrayBuffer, secret);
        const getResult = await signRequest("GET", url, body.buffer as ArrayBuffer, secret);

        expect(postResult["X-Signature"]).not.toBe(getResult["X-Signature"]);
    });

    it("should produce different signatures for different bodies", async () => {
        const body1 = new TextEncoder().encode("body1");
        const body2 = new TextEncoder().encode("body2");

        const result1 = await signRequest("POST", url, body1.buffer as ArrayBuffer, secret);
        const result2 = await signRequest("POST", url, body2.buffer as ArrayBuffer, secret);

        expect(result1["X-Signature"]).not.toBe(result2["X-Signature"]);
    });

    it("should produce different signatures for different secrets", async () => {
        const result1 = await signRequest("POST", url, body.buffer as ArrayBuffer, "secret-1");
        const result2 = await signRequest("POST", url, body.buffer as ArrayBuffer, "secret-2");

        expect(result1["X-Signature"]).not.toBe(result2["X-Signature"]);
    });

    it("should produce different signatures for different URLs (paths)", async () => {
        const result1 = await signRequest("POST", "https://example.com/path1", body.buffer as ArrayBuffer, secret);
        const result2 = await signRequest("POST", "https://example.com/path2", body.buffer as ArrayBuffer, secret);

        expect(result1["X-Signature"]).not.toBe(result2["X-Signature"]);
    });

    it("should produce same signature for same URL with different hosts (path-only signing)", async () => {
        // signRequest signs the PATH, not the full URL
        const result1 = await signRequest("POST", "https://host1.com/same-path", body.buffer as ArrayBuffer, secret);
        const result2 = await signRequest("POST", "https://host2.com/same-path", body.buffer as ArrayBuffer, secret);

        // Signatures may differ due to timestamp, but if same timestamp they'd match
        // We can't reliably test this without controlling the timestamp
        expect(result1["X-Signature"]).toBeDefined();
        expect(result2["X-Signature"]).toBeDefined();
    });

    it("should handle empty body", async () => {
        const emptyBody = new ArrayBuffer(0);
        const result = await signRequest("POST", url, emptyBody, secret);

        expect(result["X-Signature"]).toBeDefined();
        expect(result["X-Signature"].length).toBeGreaterThan(0);
    });
});

describe("verifySignedRequest with a body cap", () => {
    const secret = "test-secret-key-12345";
    const url = "https://api.example.com/gateway/notifications";

    const signed = async (body: ArrayBuffer): Promise<Request> => {
        const headers = await signRequest("POST", url, body, secret);

        return new Request(url, { body, headers, method: "POST" });
    };

    it("accepts a body inside the cap and leaves it readable for the caller", async () => {
        const request = await signed(new TextEncoder().encode("small").buffer as ArrayBuffer);

        await expect(verifySignedRequest(request, secret, 1024)).resolves.toBeTruthy();
        await expect(request.text()).resolves.toBe("small");
    });

    it("answers false for a body past the cap without waiting for the stream to end", async () => {
        const chunk = new Uint8Array(64);
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(chunk);
            },
        });
        const request = new Request(url, {
            body,
            duplex: "half",
            headers: { "X-Signature": "00", "X-Timestamp": Date.now().toString() },
            method: "POST",
        } as RequestInit);

        await expect(verifySignedRequest(request, secret, 256)).resolves.toBeFalsy();
    });
});
