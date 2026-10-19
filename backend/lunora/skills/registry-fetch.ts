/**
 * Reads a SKILL.md from one of the URLs `source-url.ts` built. The text is
 * untrusted: it is size-capped while it streams (never trusting Content-Length),
 * redirects are not followed (the answer would be a host nobody checked), and
 * every body is consumed or cancelled. `importSkill` parses it again on the server.
 */
import { assertOk, FETCH_TIMEOUT_MS, fetchWithDeadline, HttpError } from "../lib/fetch-timeout";
import { SKILL_IMPORT_LIMITS } from "./markdown";

/** A refusal with a message fit to show the user. */
export class SkillSourceError extends Error {}

type Fetcher = (url: string, init: RequestInit & { timeoutMs?: number }) => Promise<Response>;

const concatenate = (chunks: Uint8Array[], total: number): Uint8Array => {
    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return bytes;
};

const readCapped = async (response: Response, limit: number): Promise<string> => {
    const reader = response.body?.getReader();

    if (!reader) {
        return "";
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > limit) {
            await reader.cancel();

            throw new SkillSourceError(`That SKILL.md is larger than ${Math.round(limit / 1024)} KB.`);
        }

        chunks.push(value);
    }

    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(concatenate(chunks, total));
    } catch {
        throw new SkillSourceError("That file is not valid UTF-8 text.");
    }
};

/** The first URL that answers with a SKILL.md, or `null` when none does (all 404). */
export const fetchSkillMarkdown = async (
    urls: ReadonlyArray<string>,
    fetcher: Fetcher = fetchWithDeadline,
    limit: number = SKILL_IMPORT_LIMITS.markdownBytes,
): Promise<{ markdown: string; url: string } | null> => {
    for (const url of urls) {
        const response = await fetcher(url, { headers: { accept: "text/plain" }, redirect: "manual", timeoutMs: FETCH_TIMEOUT_MS });

        if (response.status === 404) {
            await response.body?.cancel();

            continue;
        }

        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();

            throw new SkillSourceError("That link redirects elsewhere; use the direct link to the SKILL.md.");
        }

        try {
            await assertOk(response, "GitHub error");
        } catch (error) {
            throw error instanceof HttpError ? new SkillSourceError(`GitHub answered ${error.status}.`) : error;
        }

        return { markdown: await readCapped(response, limit), url };
    }

    return null;
};
