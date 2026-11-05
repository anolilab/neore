/**
 * Route handlers load on their first request (`lazy` and the inline `import()`s in
 * `http.ts`), so a wrong module path, export name or route registration would only
 * show at runtime. These send a first request through the real router and check
 * that it reaches the handler the route names.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const chatStartHttpAction = vi.fn(async () => new Response("chat started", { status: 202 }));
const handleUploadRequest = vi.fn(async () => new Response(null, { status: 201 }));

vi.mock("./chat/http", () => {
    return { chatStartHttpAction };
});

vi.mock("./lib/upload-route", () => {
    return { handleUploadRequest, refuseDeclaredPurpose: () => undefined };
});

const lunoraCtx = { auth: { userId: undefined } };
const files = { bucket: "files" };

let httpApp: typeof import("./http").httpApp;

beforeAll(async () => {
    vi.stubEnv("ADMIN", "admin@test.com");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-that-is-long-enough");
    vi.stubEnv("ENCRYPTION_KEY", btoa("k".repeat(32)));
    vi.stubEnv("ENVIRONMENT", "development");
    vi.stubEnv("JWKS", '{"keys":[]}');
    vi.stubEnv("SITE_URL", "http://localhost:5173");

    ({ httpApp } = await import("./http"));
});

afterAll(() => {
    vi.unstubAllEnvs();
});

const send = async (path: string, init: RequestInit): Promise<Response> =>
    await httpApp.request(path, init, { __lunoraCtx: lunoraCtx, FILES: files });

describe("lazy HTTP routes", () => {
    it("loads the chat module on the first /chat/start and hands it the request", async () => {
        const response = await send("/chat/start", { body: JSON.stringify({ prompt: "hi" }), method: "POST" });

        expect(response.status).toBe(202);
        await expect(response.text()).resolves.toBe("chat started");
        expect(chatStartHttpAction).toHaveBeenCalledOnce();

        const [context, request] = chatStartHttpAction.mock.calls[0] as unknown as [unknown, Request];

        expect(context).toBe(lunoraCtx);
        expect(new URL(request.url).pathname).toBe("/chat/start");
        await expect(request.json()).resolves.toStrictEqual({ prompt: "hi" });
    });

    it("loads the upload module on the first TUS create and passes the FILES bucket", async () => {
        const response = await send("/uploads", { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "4" }, method: "POST" });

        expect(response.status).toBe(201);
        expect(handleUploadRequest).toHaveBeenCalledOnce();

        const [context, request, bucket] = handleUploadRequest.mock.calls[0] as unknown as [unknown, Request, unknown];

        expect(context).toBe(lunoraCtx);
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/uploads");
        expect(bucket).toBe(files);
    });

    it("routes a PATCH to an upload id to the same lazily loaded handler", async () => {
        handleUploadRequest.mockClear();

        await send("/uploads/abc123", { body: "data", headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": "0" }, method: "PATCH" });

        expect(handleUploadRequest).toHaveBeenCalledOnce();

        const [, request] = handleUploadRequest.mock.calls[0] as unknown as [unknown, Request];

        expect(new URL(request.url).pathname).toBe("/uploads/abc123");
    });
});
