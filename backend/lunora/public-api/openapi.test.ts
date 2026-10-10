/**
 * The route table is the single source for both the router and the spec; these
 * tests pin the properties that make that worth anything.
 */
import { describe, expect, it, vi } from "vitest";

import { buildOpenApiDocument, renderDocsHtml } from "./openapi";
import { missingScopes } from "./router";
import { ROUTES, toHonoPath } from "./routes";

// The chat handler drags the whole agent graph in, which does not load outside
// workerd; the route table only needs the reference.
vi.mock("../chat/http", () => {
    return { runChatStart: vi.fn() };
});

describe("public API route table", () => {
    it("has unique operation ids and method+path pairs", () => {
        expect(new Set(ROUTES.map((route) => route.operationId)).size).toBe(ROUTES.length);
        expect(new Set(ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(ROUTES.length);
    });

    it("requires a scope on every route except /me", () => {
        for (const route of ROUTES) {
            expect(route.scopes.length > 0 || route.path === "/me", route.operationId).toBe(true);
        }
    });

    it("requires a write scope on every mutating route", () => {
        const mutating = ROUTES.filter((candidate) => candidate.method !== "get" && candidate.operationId !== "streamChat");

        for (const route of mutating) {
            expect(
                route.scopes.some(([, action]) => action === "write"),
                route.operationId,
            ).toBe(true);
        }
    });

    it("converts path templates for hono", () => {
        expect(toHonoPath("/threads/{threadId}/messages")).toBe("/threads/:threadId/messages");
    });

    it("reports missing scopes by name", () => {
        const identity = { apiKeyId: "k", apiKeyScopes: { skills: ["read" as const] }, authMethod: "api_key" as const, userId: "u" };
        const runSkill = ROUTES.find((route) => route.operationId === "runSkill")!;

        expect(missingScopes(identity, runSkill)).toEqual(["chat:write"]);
    });
});

describe("OpenAPI document", () => {
    const document = buildOpenApiDocument("https://backend.example/");
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;

    it("is 3.1 and points at the v1 server", () => {
        expect(document["openapi"]).toBe("3.1.0");
        expect(document["servers"]).toEqual([{ url: "https://backend.example/api/v1" }]);
    });

    it("documents every served route with its scopes, parameters and error responses", () => {
        for (const route of ROUTES) {
            const operation = paths[route.path]?.[route.method];

            expect(operation, `${route.method} ${route.path}`).toBeDefined();
            expect(operation!["x-required-scopes"]).toEqual(route.scopes.map(([resource, action]) => `${resource}:${action}`));
            expect(Object.keys(operation!["responses"] as object)).toEqual(expect.arrayContaining([String(route.successStatus ?? 200), "401", "429"]));

            for (const [, name] of route.path.matchAll(/\{(\w+)\}/gu)) {
                expect((operation!["parameters"] as { name: string }[]).some((parameter) => parameter.name === name)).toBe(true);
            }
        }
    });

    it("advertises Idempotency-Key on POSTs only", () => {
        const hasHeader = (operation: Record<string, unknown>) =>
            ((operation["parameters"] as { name: string }[] | undefined) ?? []).some((parameter) => parameter.name === "Idempotency-Key");

        expect(hasHeader(paths["/tasks"]!["post"]!)).toBe(true);
        expect(hasHeader(paths["/tasks"]!["get"]!)).toBe(false);
    });

    it("renders escaped docs HTML", () => {
        const html = renderDocsHtml(document);

        expect(html).toContain("/api/v1/threads/{threadId}");
        expect(html).not.toContain("<script");
    });
});
