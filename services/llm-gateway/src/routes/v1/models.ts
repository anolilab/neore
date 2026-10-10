/**
 * GET /v1/models — Model catalog endpoint.
 *
 * Returns available models (text, image, video, speech) with metadata
 * sufficient for the frontend model picker. Enriched with pricing data
 * from models.dev where available.
 *
 * Supports query parameter filters:
 *   ?mode=text|image|video|speech-to-text|text-to-speech
 *   ?provider=openai,google          (comma-separated allow list)
 *   ?region=US,EU                    (comma-separated — model must serve ≥1)
 *   ?tier=fast,frontier              (comma-separated quality tier)
 *   ?capability=reasoning,coding     (comma-separated filterCapabilities)
 *   ?enabled=true|false              (default: no filter)
 *   ?premium=true|false
 *   ?new=true|false
 *   ?tools=true|false                (supports tool calling)
 *   ?multimodal=true|false           (supports image/multimodal input)
 *   ?search=claude                   (case-insensitive name/desc/id match)
 *
 * No auth required — this is a public endpoint.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import type { GatewayModelDefinition } from "../../models.generated.js";
import { GATEWAY_MODEL_CATALOG, MODELS_VERSION } from "../../models.js";
import { PricingService } from "../../providers/pricing.js";

const modelsRouter = new OpenAPIHono<HonoEnv>();

/** The cached `/v1/models` payload — the same object the handler builds below. */
type ModelsListResponse = {
    data: unknown[];
    object: string;
    version: typeof MODELS_VERSION;
};

const MODELS_LIST_CACHE_KEY = "models_list_v4";
const MODELS_LIST_CACHE_TTL = 3600; // 1 hour

/**
 * Browser caching for the catalog. It is public, identical for every caller and
 * fetched on every app load (the model picker), so a repeat visit reads it from
 * the HTTP cache instead of re-downloading ~100 KB. Five minutes matches the
 * web client's `staleTime`; `stale-while-revalidate` keeps a refresh off the
 * critical path. `securityMiddleware` keeps a cacheable header a handler set.
 *
 * `public` is safe because the body depends on nothing but the query string and
 * the gateway's own catalog/pricing — no auth, key, org, BYOK or locale is read
 * (per-user filtering happens in the browser). `models-cache.test.ts` pins that.
 * The HEADERS do vary: `corsMiddleware` echoes an allowed Origin, and sets
 * `Vary: Origin` only then — so a shared cache primed by a no-Origin request
 * would hand the app a copy without `Access-Control-Allow-Origin`. Always
 * sending `Vary: Origin` here keeps those copies apart.
 */
const MODELS_LIST_HTTP_HEADERS = { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600", Vary: "Origin" } as const;

// ── Filter helpers ──────────────────────────────────────────────────────────

/** Parse a comma-separated query param into a string array, or undefined. */
const parseList = (value: string | undefined): string[] | undefined => {
    if (!value) return undefined;

    const items = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    return items.length > 0 ? items : undefined;
};

/** Parse "true"/"false" query param, returns undefined for anything else. */
const parseBool = (value: string | undefined): boolean | undefined => {
    if (value === "true") return true;

    if (value === "false") return false;

    return undefined;
};

/**
 * Build a stable, sorted cache-key suffix from validated filters only.
 * Only known fields with normalized values are included — arbitrary
 * attacker-controlled query params cannot poison the KV cache namespace.
 */
/** Deterministic, locale-independent string comparator (matches the default `Array#sort` ordering). */
const byCodeUnit = (a: string, b: string): number => {
    if (a < b) return -1;

    return a > b ? 1 : 0;
};

const buildFilterKey = (filters: ModelFilters): string => {
    const projection: Record<string, string> = {};

    if (filters.mode?.length) projection["mode"] = filters.mode.toSorted(byCodeUnit).join(",");

    if (filters.provider?.length) projection["provider"] = filters.provider.toSorted(byCodeUnit).join(",");

    if (filters.region?.length) projection["region"] = filters.region.toSorted(byCodeUnit).join(",");

    if (filters.tier?.length) projection["tier"] = filters.tier.toSorted(byCodeUnit).join(",");

    if (filters.capability?.length) projection["capability"] = filters.capability.toSorted(byCodeUnit).join(",");

    if (filters.enabled !== undefined) projection["enabled"] = String(filters.enabled);

    if (filters.premium !== undefined) projection["premium"] = String(filters.premium);

    if (filters.new !== undefined) projection["new"] = String(filters.new);

    if (filters.tools !== undefined) projection["tools"] = String(filters.tools);

    if (filters.multimodal !== undefined) projection["multimodal"] = String(filters.multimodal);

    if (filters.search) projection["search"] = filters.search.slice(0, 64);

    const parts: string[] = Array.from(Object.keys(projection).toSorted(byCodeUnit), (key) => `${key}=${projection[key]}`);

    return parts.length > 0 ? `:${parts.join("&")}` : "";
};

interface ModelFilters {
    capability?: string[];
    enabled?: boolean;
    mode?: string[];
    multimodal?: boolean;
    new?: boolean;
    premium?: boolean;
    provider?: string[];
    region?: string[];
    search?: string;
    tier?: string[];
    tools?: boolean;
}

/** Apply filters to the raw model catalog. */
const filterModels = (models: GatewayModelDefinition[], filters: ModelFilters): GatewayModelDefinition[] =>
    models.filter((m) => {
        // Mode
        if (filters.mode && !filters.mode.includes(m.mode)) return false;

        // Provider
        if (filters.provider) {
            const p = m.provider.toLowerCase();
            // Also check displayProvider for user-friendly matching (e.g. "anthropic" matches openrouter/anthropic models)
            const dp = m.displayProvider?.toLowerCase();

            if (filters.provider.every((fp) => !(fp === p || fp === dp))) return false;
        }

        // Region — model must serve at least one of the requested regions
        if (filters.region) {
            if (m.regions.length === 0) return false;

            if (m.regions.every((r) => !filters.region!.includes(r))) return false;
        }

        // Tier
        if (filters.tier && (!m.tier || !filters.tier.includes(m.tier))) return false;

        // Capability (filterCapabilities array)
        if (filters.capability && (!m.filterCapabilities || filters.capability.some((c) => !m.filterCapabilities!.includes(c)))) return false;

        // Enabled
        if (filters.enabled !== undefined && m.enabled !== filters.enabled) return false;

        // Premium
        if (filters.premium !== undefined) {
            if (filters.premium && !m.isPremium) return false;

            if (!filters.premium && m.isPremium) return false;
        }

        // New
        if (filters.new !== undefined) {
            if (filters.new && !m.isNew) return false;

            if (!filters.new && m.isNew) return false;
        }

        // Tool calling
        if (filters.tools !== undefined && m.supportsTools !== filters.tools) return false;

        // Multimodal
        if (filters.multimodal !== undefined && m.supportsMultimodal !== filters.multimodal) return false;

        // Free-text search
        if (filters.search) {
            const q = filters.search;
            const haystack = `${m.id} ${m.name ?? ""} ${m.desc ?? ""} ${m.displayProvider ?? ""} ${m.provider}`.toLowerCase();

            if (!haystack.includes(q)) return false;
        }

        return true;
    });

// ── Enrichment helper ───────────────────────────────────────────────────────

const enrichModel = async (model: GatewayModelDefinition, pricingService: PricingService) => {
    // Only fetch pricing for text models (image/video use per-generation pricing)
    const pricing = model.mode === "text" ? await pricingService.getPricing(model.modelApiId) : null;

    return {
        // Identity
        id: model.id,
        mode: model.mode,
        modelApiId: model.modelApiId,
        object: "model" as const,
        provider: model.provider,
        regions: model.regions,

        // UI metadata
        ...(model.name && { name: model.name }),
        ...(model.desc && { desc: model.desc }),
        ...(model.displayProvider && { displayProvider: model.displayProvider }),
        ...(model.tier && { tier: model.tier }),
        ...(model.slug && { slug: model.slug }),

        // Capabilities (flat — consumed directly by frontend)
        enabled: model.enabled,
        supportsFileInput: model.supportsFileInput,
        supportsMultimodal: model.supportsMultimodal,
        supportsTools: model.supportsTools,

        // Image/video capabilities (only included when present)
        ...(model.aspectRatios?.length && { aspectRatios: model.aspectRatios }),
        ...(model.maxResolution && { maxResolution: model.maxResolution }),
        ...(model.avgLatencyMs && { avgLatencyMs: model.avgLatencyMs }),
        ...(model.supportsNegativePrompt !== undefined && { supportsNegativePrompt: model.supportsNegativePrompt }),
        ...(model.maxDuration && { maxDuration: model.maxDuration }),
        ...(model.supportsImg2Img && { supportsImg2Img: true }),
        ...(model.supportsUpscale && { supportsUpscale: true }),
        ...(model.supportsInpaint && { supportsInpaint: true }),
        ...(model.supportsOutpaint && { supportsOutpaint: true }),
        ...(model.supportsBackgroundRemoval && { supportsBackgroundRemoval: true }),
        ...(model.supportsObjectRemoval && { supportsObjectRemoval: true }),
        ...(model.upscaleFactors?.length && { upscaleFactors: model.upscaleFactors }),
        ...(model.supportsFaceEnhance && { supportsFaceEnhance: true }),
        ...(model.supportsCharacterRef && { supportsCharacterRef: true }),
        ...(model.characterRefModes?.length && { characterRefModes: model.characterRefModes }),
        ...(model.maxReferenceImages && { maxReferenceImages: model.maxReferenceImages }),
        ...(model.supportsStyleRef && { supportsStyleRef: true }),
        ...(model.supportsTextToVideo && { supportsTextToVideo: true }),
        ...(model.supportsImageToVideo && { supportsImageToVideo: true }),
        ...(model.maxVideoDuration && { maxVideoDuration: model.maxVideoDuration }),
        ...(model.supportedFps?.length && { supportedFps: model.supportedFps }),
        ...(model.supportsControlNet && { supportsControlNet: true }),
        ...(model.controlNetTypes?.length && { controlNetTypes: model.controlNetTypes }),
        ...(model.isPreprocessor && { isPreprocessor: true }),
        ...(model.preprocessorType && { preprocessorType: model.preprocessorType }),

        // Flags
        ...(model.isPremium && { isPremium: true }),
        ...(model.isNew && { isNew: true }),
        ...(model.legacy && { legacy: true }),
        ...(model.featureFlag && { featureFlag: model.featureFlag }),
        ...(model.filterCapabilities?.length && { filterCapabilities: model.filterCapabilities }),

        // Pricing (enriched from models.dev, text models only)
        ...(pricing && {
            context_window: pricing.contextWindow,
            pricing: {
                input_per_million: pricing.inputPerMillion / 1_000_000,
                output_per_million: pricing.outputPerMillion / 1_000_000,
                ...(pricing.cachedInputPerMillion && { cached_input_per_million: pricing.cachedInputPerMillion / 1_000_000 }),
            },
        }),
    };
};

// ── Route definition ────────────────────────────────────────────────────────

modelsRouter.openapi(
    {
        method: "get",
        path: "/v1/models",
        request: {
            query: z.object({
                capability: z.string().optional().openapi({
                    description: "Filter by capabilities (comma-separated): reasoning, coding, vision, image_generation, etc.",
                    example: "reasoning",
                }),
                enabled: z.enum(["true", "false"]).optional().openapi({ description: "Filter by enabled status" }),
                mode: z
                    .string()
                    .optional()
                    .openapi({ description: "Filter by mode (comma-separated): text, image, video, speech-to-text, text-to-speech", example: "text" }),
                multimodal: z.enum(["true", "false"]).optional().openapi({ description: "Filter by multimodal (image input) support" }),
                new: z.enum(["true", "false"]).optional().openapi({ description: "Filter recently added models" }),
                premium: z.enum(["true", "false"]).optional().openapi({ description: "Filter premium models" }),
                provider: z
                    .string()
                    .optional()
                    .openapi({ description: "Filter by provider (comma-separated): openai, google, anthropic, etc.", example: "openai,google" }),
                region: z
                    .string()
                    .optional()
                    .openapi({ description: "Filter by region (comma-separated): US, EU, etc. Model must serve at least one", example: "EU" }),
                search: z.string().optional().openapi({ description: "Free-text search across model name, description, provider, and ID", example: "claude" }),
                tier: z
                    .string()
                    .optional()
                    .openapi({ description: "Filter by quality tier (comma-separated): budget, fast, medium, high-quality, frontier", example: "frontier" }),
                tools: z.enum(["true", "false"]).optional().openapi({ description: "Filter by tool/function calling support" }),
            }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Model list",
            },
        },
        summary: "List available models with pricing and metadata",
        tags: ["SaaS API"],
    },
    async (c) => {
        const kv = c.env.PRICING_KV;
        const query = c.req.query();

        // Parse filter parameters
        const filters: ModelFilters = {
            capability: parseList(query.capability)?.map((cap) => cap.toLowerCase()),
            enabled: parseBool(query.enabled),
            mode: parseList(query.mode)?.map((m) => m.toLowerCase()),
            multimodal: parseBool(query.multimodal),
            new: parseBool(query.new),
            premium: parseBool(query.premium),
            provider: parseList(query.provider)?.map((p) => p.toLowerCase()),
            region: parseList(query.region)?.map((r) => r.toUpperCase()),
            search: query.search?.toLowerCase().trim() || undefined,
            tier: parseList(query.tier)?.map((t) => t.toLowerCase()),
            tools: parseBool(query.tools),
        };

        // Build a cache key from the version + validated filters only.
        // Never use raw query params — they're attacker-controlled and would
        // pollute the KV namespace with unbounded entries.
        const filterSuffix = buildFilterKey(filters);
        const cacheKey = `${MODELS_LIST_CACHE_KEY}:${MODELS_VERSION}${filterSuffix}`;

        // Check KV cache
        try {
            const cached = await kv.get(cacheKey, "json");

            if (cached) {
                return c.json(cached as ModelsListResponse, 200, MODELS_LIST_HTTP_HEADERS);
            }
        } catch {
            // Cache miss — build fresh
        }

        // Apply filters to catalog
        const filteredCatalog = filterModels(GATEWAY_MODEL_CATALOG, filters);

        const pricingService = new PricingService(c.env);

        // Enrich models with pricing data in parallel
        const enrichedModels = await Promise.all(filteredCatalog.map((model) => enrichModel(model, pricingService)));

        // Add the "auto" meta-model only when no mode filter or mode includes "text"
        const includeAuto = !filters.mode || filters.mode.includes("text");
        const data = includeAuto
            ? [
                  ...enrichedModels,
                  {
                      desc: "Automatically selects the best model based on query complexity",
                      enabled: true,
                      id: "auto",
                      mode: "text" as const,
                      modelApiId: "auto",
                      name: "Auto (Smart Routing)",
                      object: "model" as const,
                      provider: "neore",
                      regions: [],
                      supportsFileInput: false,
                      supportsMultimodal: true,
                      supportsTools: true,
                  },
              ]
            : enrichedModels;

        const response = {
            data,
            object: "list" as const,
            version: MODELS_VERSION,
        };

        // Cache the enriched list (shorter TTL for filtered requests to limit KV bloat)
        const ttl = filterSuffix ? Math.min(MODELS_LIST_CACHE_TTL, 300) : MODELS_LIST_CACHE_TTL;

        c.executionCtx.waitUntil(kv.put(cacheKey, JSON.stringify(response), { expirationTtl: ttl }).catch(() => {}));

        return c.json(response, 200, MODELS_LIST_HTTP_HEADERS);
    },
);

export { modelsRouter };

// Exported for unit testing
export { buildFilterKey, filterModels, type ModelFilters, parseBool, parseList };
