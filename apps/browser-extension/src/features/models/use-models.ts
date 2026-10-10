import type { GatewayModel } from "@neore/ai/models";
import { useEffect, useState } from "react";

import { LLM_GATEWAY_URL } from "@/lib/env";

const EMPTY: GatewayModel[] = [];

let cache: Promise<GatewayModel[]> | undefined;

/**
 * The gateway's public `/v1/models` catalog (the same source the web app's
 * picker uses), narrowed to text models: the side panel has no image/video UI.
 * Fetched once per panel lifetime; a failure is retried on next mount.
 */
const loadModels = (): Promise<GatewayModel[]> => {
    cache ??= fetch(`${LLM_GATEWAY_URL}/v1/models`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) })
        .then(async (response) => {
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`Gateway /v1/models returned ${response.status}`);
            }

            const { data } = (await response.json()) as { data?: GatewayModel[] };

            return (data ?? []).filter((model) => model.enabled && model.id !== "auto" && model.mode === "text");
        })
        .catch((error: unknown) => {
            cache = undefined;
            throw error;
        });

    return cache;
};

export function useModels(): GatewayModel[] {
    const [models, setModels] = useState<GatewayModel[]>(EMPTY);

    useEffect(() => {
        if (!LLM_GATEWAY_URL) {
            return undefined;
        }

        let cancelled = false;

        const load = async () => {
            try {
                const loaded = await loadModels();

                if (!cancelled) {
                    setModels(loaded);
                }
            } catch (error: unknown) {
                console.warn("[anole] could not load models", error);
            }
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, []);

    return models;
}
