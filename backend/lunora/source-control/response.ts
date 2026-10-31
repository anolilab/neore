/**
 * Reading a host's response: bounded, and checked against the shape the driver expects.
 * A response that is too large, not JSON or the wrong shape is a `HostApiError`.
 */
import type z from "zod/v4";

import { HostApiError } from "./origin-fetch";

const RESPONSE_MAX_BYTES = 12_000_000;

/** Cancels a response body nobody will read; a failure to cancel is not worth reporting. */
export const discard = async (response: Response): Promise<void> => {
    await response.body?.cancel().catch(() => undefined);
};

/** The body as text, read up to `RESPONSE_MAX_BYTES`: the cap bounds memory, not just what is kept. */
export const readText = async (response: Response): Promise<string> => {
    const tooLarge = new HostApiError("The host's response is larger than this reads", 0);
    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) {
        await discard(response);

        throw tooLarge;
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (reader) {
        // The request's deadline also covers the body: a slow or cut-off read is a host failure.
        const { done, value } = await reader.read().catch(() => {
            throw new HostApiError("The host's response could not be read", 0);
        });

        if (done) {
            break;
        }

        received += value.byteLength;

        if (received > RESPONSE_MAX_BYTES) {
            await reader.cancel();

            throw tooLarge;
        }

        chunks.push(value);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(bytes);
};

export const readJson = async (response: Response): Promise<unknown> => {
    const text = await readText(response);

    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new HostApiError("The host's response was not JSON", 0);
    }
};

export const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);

    if (!result.success) {
        throw new HostApiError("The host's response did not have the expected shape", 0);
    }

    return result.data;
};
