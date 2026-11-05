import type { HttpHandler } from "msw";
import { delay, http, HttpResponse } from "msw";

import env from "@/lib/env";

const TUS_HEADERS = { "Tus-Resumable": "1.0.0" };

interface UploadOptions {
    /** Pause per chunk, so the progress bar moves. Default 150 ms. */
    delayMs?: number;
    /** Fail the create with this status (413 too large, 415 type not allowed, 429 rate limited). */
    status?: number;
}

/**
 * The TUS upload route (`<backend>/uploads`, `lib/upload/upload-file.ts`): create, then `PATCH`
 * the bytes, answered in memory. The upload id it hands back is what the finalize procedure
 * (a Lunora fixture of the story) receives.
 */
export const uploadHandlers = (options: UploadOptions = {}): HttpHandler[] => {
    const offsets = new Map<string, number>();
    let next = 0;

    return [
        http.post(`${env.VITE_LUNORA_URL}/uploads`, () => {
            if (options.status) {
                return new HttpResponse(null, { headers: TUS_HEADERS, status: options.status });
            }

            next += 1;
            const id = `upload_${String(next)}`;

            offsets.set(id, 0);

            return new HttpResponse(null, { headers: { ...TUS_HEADERS, Location: `${env.VITE_LUNORA_URL}/uploads/${id}`, "Upload-Offset": "0" }, status: 201 });
        }),
        http.head(`${env.VITE_LUNORA_URL}/uploads/:id`, ({ params }) => {
            const offset = offsets.get(String(params.id)) ?? 0;

            return new HttpResponse(null, { headers: { ...TUS_HEADERS, "Upload-Offset": String(offset) }, status: 200 });
        }),
        http.patch(`${env.VITE_LUNORA_URL}/uploads/:id`, async ({ params, request }) => {
            const id = String(params.id);
            const body = await request.arrayBuffer();
            const offset = (offsets.get(id) ?? 0) + body.byteLength;

            await delay(options.delayMs ?? 150);
            offsets.set(id, offset);

            return new HttpResponse(null, { headers: { ...TUS_HEADERS, "Upload-Offset": String(offset) }, status: 204 });
        }),
    ];
};
