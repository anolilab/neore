/**
 * The OpenAPI 3.1 document for `/api/v1`, built from the route table in
 * `routes.ts` — the same table the router mounts — so a route cannot be served
 * undocumented or documented unserved. Served at `/api/v1/openapi.json`.
 */
import z from "zod/v4";

import { API_ERROR_CODES } from "./errors";
import { IDEMPOTENCY_HEADER } from "./idempotency";
import { PUBLIC_API_PREFIX } from "./identity";
import type { RouteDefinition } from "./routes";
import { ROUTES } from "./routes";
import { zErrorBodySchema } from "./schemas";
import { API_ACTIONS, API_RESOURCES, formatScope } from "./scopes";

export const PUBLIC_API_VERSION = "1.0.0";

const TRAILING_SLASH = /\/$/u;

type JsonSchema = Record<string, unknown>;

const toSchema = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
    const document = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;

    // Embedded in an OpenAPI document, which declares its own dialect.
    delete document["$schema"];

    return document;
};

const errorResponse = (description: string) => {
    return { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }, description };
};

const pathParameters = (path: string) =>
    [...path.matchAll(/\{(\w+)\}/gu)].map((match) => {
        return { in: "path", name: match[1], required: true, schema: { type: "string" } };
    });

const queryParameters = (route: RouteDefinition) => {
    if (!route.query) {
        return [];
    }

    const schema = toSchema(route.query, "input") as { properties?: Record<string, JsonSchema>; required?: string[] };

    return Object.entries(schema.properties ?? {}).map(([name, property]) => {
        return {
            ...(typeof property["description"] === "string" && { description: property["description"] }),
            in: "query",
            name,
            required: schema.required?.includes(name) ?? false,
            schema: { type: "string" },
        };
    });
};

const operation = (route: RouteDefinition) => {
    const status = String(route.successStatus ?? 200);
    const scopes = route.scopes.map(([resource, action]) => formatScope(resource, action));
    const scopeList = scopes.map((scope) => `\`${scope}\``).join(", ");
    const scopeNote = scopes.length > 0 ? `Requires: ${scopeList}.` : "Any valid key.";
    const parameters = [...pathParameters(route.path), ...queryParameters(route)];

    if (route.method === "post") {
        parameters.push({
            description: "Makes the POST safe to retry: the same key with the same body replays the first response for 24 hours.",
            in: "header",
            name: IDEMPOTENCY_HEADER,
            required: false,
            schema: { type: "string" },
        } as never);
    }

    const successContent =
        route.response === "ndjson"
            ? { "application/x-ndjson": { schema: { type: "string" } } }
            : { "application/json": { schema: toSchema(route.response, "output") } };

    return {
        description: [route.description, scopeNote].filter(Boolean).join("\n\n"),
        operationId: route.operationId,
        ...(parameters.length > 0 && { parameters }),
        ...(route.body && { requestBody: { content: { "application/json": { schema: toSchema(route.body, "input") } }, required: true } }),
        responses: {
            400: errorResponse("`invalid_request`"),
            401: errorResponse("`unauthenticated` or `invalid_api_key`"),
            403: errorResponse("`insufficient_scope` or `forbidden`"),
            404: errorResponse("`not_found`"),
            [status]: { content: successContent, description: "Success" },
            ...(route.method === "post" && { 409: errorResponse("`conflict` or `idempotency_in_progress`"), 422: errorResponse("`idempotency_conflict`") }),
            429: errorResponse("`rate_limited` (per key) or `daily_limit_reached`; honour `Retry-After`"),
            500: errorResponse("`internal_error`"),
        },
        security: [{ bearerAuth: [] }],
        summary: route.summary,
        tags: [route.tag],
        "x-required-scopes": scopes,
    };
};

export const buildOpenApiDocument = (serverUrl?: string): Record<string, unknown> => {
    const paths: Record<string, Record<string, unknown>> = {};

    for (const route of ROUTES) {
        paths[route.path] = { ...paths[route.path], [route.method]: operation(route) };
    }

    return {
        components: {
            schemas: { Error: toSchema(zErrorBodySchema, "output") },
            securitySchemes: {
                bearerAuth: {
                    description: `An API key from Settings → API keys, sent as \`Authorization: Bearer <key>\` (or \`X-API-Key\`). Scopes: ${API_RESOURCES.flatMap((resource) => API_ACTIONS.map((action) => formatScope(resource, action))).join(", ")}.`,
                    scheme: "bearer",
                    type: "http",
                },
            },
        },
        info: {
            description: [
                "Programmatic access to chats, threads, skills, tasks, the knowledge base and memories.",
                "",
                `**Errors** share one shape — \`{ "error": { "code", "message", "requestId" } }\`. Codes: ${Object.keys(API_ERROR_CODES)
                    .map((code) => `\`${code}\``)
                    .join(", ")}.`,
                "",
                "**Pagination**: list endpoints take `limit` (1-100) and `cursor`, and answer `{ data, nextCursor }`; `nextCursor` is `null` on the last page.",
                "",
                "**Rate limits** apply per API key (reads and writes separately) on top of your account's own limits, including the daily message limit.",
            ].join("\n"),
            title: "Neore API",
            version: PUBLIC_API_VERSION,
        },
        openapi: "3.1.0",
        paths,
        servers: [{ url: serverUrl ? `${serverUrl.replace(TRAILING_SLASH, "")}${PUBLIC_API_PREFIX}` : PUBLIC_API_PREFIX }],
        tags: [...new Set(ROUTES.map((route) => route.tag))].map((name) => {
            return { name };
        }),
    };
};

/** A dependency-free reference page over the spec: no CDN script, nothing to allowlist. */
export const renderDocsHtml = (document: Record<string, unknown>): string => {
    const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const paths = document["paths"] as Record<string, Record<string, { description?: string; summary: string; tags: string[] }>>;
    const rows = Object.entries(paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(
            ([method, op]) =>
                `<section><h3><code class="m m-${method}">${method.toUpperCase()}</code> <code>${escape(PUBLIC_API_PREFIX + path)}</code></h3><p><strong>${escape(op.summary)}</strong></p>${(
                    op.description ?? ""
                )
                    .split("\n\n")
                    .map((paragraph) => `<p>${escape(paragraph)}</p>`)
                    .join("")}</section>`,
        ),
    );
    const info = document["info"] as { description: string; title: string; version: string };

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(info.title)} reference</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1b1b1f;background:#fff}@media(prefers-color-scheme:dark){body{color:#e6e6ea;background:#141417}section{border-color:#333}}h1{margin-bottom:.2rem}section{border-top:1px solid #ddd;padding:.4rem 0}code{font:13px ui-monospace,monospace}.m{padding:.1rem .4rem;border-radius:4px;color:#fff}.m-get{background:#2b6cb0}.m-post{background:#2f855a}.m-delete{background:#c53030}pre{white-space:pre-wrap}</style></head>
<body><main><h1>${escape(info.title)}</h1><p>Version ${escape(info.version)} · <a href="${PUBLIC_API_PREFIX}/openapi.json">openapi.json</a></p><pre>${escape(info.description)}</pre>${rows.join("")}</main></body></html>`;
};
