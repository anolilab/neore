"use client";

import type { GatewayModel } from "@neore/ai/models";
import { useQuery } from "@tanstack/react-query";

import env from "@/lib/env";

// Module-level so the empty case keeps a stable identity for consumers that
// put the result in an effect/query dependency.
const EMPTY_MODELS: GatewayModel[] = [];

interface GatewayModelsResponse {
    data: GatewayModel[];
    object: "list";
    version: string;
}

/**
 * Fetch model catalog from the LLM Gateway.
 */
async function fetchGatewayModels(): Promise<GatewayModelsResponse> {
    const url = `${env.VITE_LLM_GATEWAY_URL}/v1/models`;
    const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
        throw new Error(`Gateway /v1/models returned ${response.status}`);
    }

    return response.json() as Promise<GatewayModelsResponse>;
}

/**
 * Hook that fetches the full model catalog from the LLM Gateway.
 *
 * Returns GatewayModel[] — the canonical model shape with pricing,
 * regions, and all capabilities. No transformation needed.
 * Refetches every 5 minutes; the gateway caches for 1 hour.
 */
export function useGatewayModels(): GatewayModel[] {
    const { data } = useQuery({
        gcTime: 30 * 60 * 1000, // 30 minutes
        queryFn: fetchGatewayModels,
        queryKey: ["gateway-models"],
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });

    if (!data?.data) {
        return EMPTY_MODELS;
    }

    // Filter out the "auto" meta-model — gateway is the source of truth
    return data.data.filter((m) => m.id !== "auto" && m.enabled);
}
