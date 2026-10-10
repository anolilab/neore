import { afterEach, describe, expect, it, vi } from "vitest";

import { UploadFailedError } from "./upload-error";
import { uploadFile } from "./upload-file";

vi.mock("@/lib/auth/server-functions", () => {
    return { default: async () => "session-jwt" };
});

vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "http://localhost:8788" } };
});

const UPLOAD_URL = "http://localhost:8788/uploads/upload-1";

/** A TUS server as the backend's upload route answers, recording every request. */
const tusServer = (createStatus = 201) => {
    const requests: { headers: Headers; method: string; url: string }[] = [];
    let offset = 0;

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);

        requests.push({ headers: request.headers, method: request.method, url: request.url });

        if (request.method === "POST") {
            return new Response(null, { headers: { Location: UPLOAD_URL, "Upload-Offset": "0" }, status: createStatus });
        }

        if (request.method === "PATCH") {
            const chunk = await request.arrayBuffer();

            offset += chunk.byteLength;

            return new Response(null, { headers: { "Upload-Offset": String(offset) }, status: 204 });
        }

        return new Response(null, { headers: { "Upload-Length": String(offset), "Upload-Offset": String(offset) }, status: 200 });
    });

    return { fetch, requests };
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(uploadFile, () => {
    it("sends the file over TUS with the bearer in a header, never the URL, and answers the upload id", async () => {
        const server = tusServer();

        vi.stubGlobal("fetch", server.fetch);

        const progress: number[] = [];
        const id = await uploadFile(new File(["%PDF-1.7"], "a.pdf"), {
            contentType: "application/pdf",
            onProgress: (percent) => {
                progress.push(percent);
            },
        });

        expect(id).toBe("upload-1");
        expect(server.requests[0]).toMatchObject({ method: "POST", url: "http://localhost:8788/uploads" });
        // The declared type rides the metadata as `mimeType`, which the server prefers over `filetype`.
        expect(server.requests[0]?.headers.get("Upload-Metadata")).toContain(`mimeType ${btoa("application/pdf")}`);

        for (const request of server.requests) {
            expect(request.headers.get("Authorization")).toBe("Bearer session-jwt");
            expect(request.url).not.toContain("session-jwt");
        }

        expect(progress.at(-1)).toBe(100);
    });

    it.each([
        [413, "too-large"],
        [415, "unsupported"],
        [403, "rejected"],
    ])("words a %i on create as %s", async (status, reason) => {
        vi.stubGlobal("fetch", tusServer(status).fetch);

        const error = await uploadFile(new File(["x"], "a.pdf"), { contentType: "application/pdf" }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(UploadFailedError);
        expect(error).toMatchObject({ reason, status });
    });
});
