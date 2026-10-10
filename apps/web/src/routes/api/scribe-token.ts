import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import { fetchAuthMutation, getToken } from "../../lib/auth/server";

/** Backend refusals that mean "not for this caller", mapped to the status the composer expects. */
const SCRIBE_DENIAL_STATUS: Record<string, number> = {
    FORBIDDEN: 403,
    TOO_MANY_REQUESTS: 429,
    UNAUTHORIZED: 401,
};

/** A Lunora error carries its code on `.code` or `.data.code`. */
const readErrorCode = (error: unknown): string | undefined => {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    const { code, data } = error as { code?: unknown; data?: { code?: unknown } };
    const value = typeof code === "string" ? code : data?.code;

    return typeof value === "string" ? value : undefined;
};

export const Route = createFileRoute("/api/scribe-token")({
    server: {
        handlers: {
            POST: async ({ request: _request }) => {
                // Auth gate: this endpoint mints paid ElevenLabs tokens, so the
                // backend authorizes each one — a non-anonymous account, metered
                // by the `voice/scribeToken` rate limit — before the key is used.
                // The composer reads every non-OK status as "fall back to the
                // Web Speech API".
                const sessionToken = await getToken().catch(() => undefined);

                if (!sessionToken) {
                    return Response.json({ error: "Not authenticated" }, { status: 401 });
                }

                const { ELEVENLABS_API_KEY } = process.env;

                // 503, not 500: the composer's dictation reads this status as
                // "realtime dictation is off" and falls back to the Web Speech API.
                if (!ELEVENLABS_API_KEY) {
                    return Response.json(
                        { error: "ElevenLabs API key not configured" },
                        {
                            status: 503,
                            headers: { "Content-Type": "application/json" },
                        },
                    );
                }

                // After the key check, so an unconfigured deployment does not
                // spend the caller's rate-limit budget on tokens it cannot mint.
                try {
                    await fetchAuthMutation(api.voice.functions.authorizeScribeToken, {});
                } catch (error) {
                    const status = SCRIBE_DENIAL_STATUS[readErrorCode(error) ?? ""];

                    if (!status) {
                        console.error("Failed to authorize scribe token:", error);

                        return Response.json({ error: "Failed to get token" }, { status: 500 });
                    }

                    return Response.json({ error: "Realtime dictation is not available" }, { status });
                }

                try {
                    const response = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
                        method: "POST",
                        headers: {
                            "xi-api-key": ELEVENLABS_API_KEY,
                        },
                    });

                    if (!response.ok) {
                        await response.body?.cancel();

                        throw new Error(`ElevenLabs API error: ${response.status}`);
                    }

                    const data = (await response.json()) as { token: string };

                    return Response.json({ token: data.token });
                } catch (error) {
                    console.error("Failed to get ElevenLabs token:", error);

                    return Response.json(
                        { error: "Failed to get token" },
                        {
                            status: 500,
                            headers: { "Content-Type": "application/json" },
                        },
                    );
                }
            },
        },
    },
});
