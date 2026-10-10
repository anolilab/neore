import { describe, expect, it, vi } from "vitest";

import { ARTIFACT_PREVIEW_PATH, PREVIEW_SHELL_CSP } from "@/features/canvas/lib/preview-shell";

import securityMiddleware, { buildCSPDirectives, LOCAL_MODEL_CONNECT_SOURCES } from "./security-middleware";

const mockEnv = vi.hoisted<Record<string, string | undefined>>(() => {
    return {
        VITE_LLM_GATEWAY_URL: "https://gateway.example",
        VITE_LUNORA_URL: "https://backend.example",
        VITE_POSTHOG_HOST: "https://eu.i.posthog.com",
    };
});

vi.mock("@/lib/env", () => {
    return { default: mockEnv };
});

interface MiddlewareArgs {
    context: Record<string, unknown>;
    next: (options?: { context?: Record<string, unknown> }) => Promise<unknown>;
    pathname: string;
    request: Request;
}

// The request-middleware server function, exactly as TanStack Start invokes it.
const run = (securityMiddleware as unknown as { options: { server: (args: MiddlewareArgs) => Promise<unknown> } }).options.server;

/** Private ranges, mDNS names, wildcard hosts and a bare `http:` scheme — everything wider than loopback. */
const BEYOND_LOOPBACK_RE = /192\.168|10\.\d|172\.(?:1[6-9]|2\d|3[01])|\.local\b|\*\.localhost|http:\/\/\*|\bhttp:(?=\s|$)/u;
const LOOPBACK_RE = /localhost|127\.0\.0\.1/u;
const byString = (a: string, b: string) => a.localeCompare(b);

const directive = (csp: string, name: string): string[] =>
    csp
        .split("; ")
        .find((part) => part.startsWith(`${name} `))
        ?.split(" ")
        .slice(1) ?? [];

/** What `next()` really resolves to in Start: the middleware context, not a Response. */
const invoke = async (url: string) => {
    const request = new Request(url);
    const downstream = new Response("<html></html>", { headers: { "Content-Type": "text/html" }, status: 200 });
    let nonce: string | undefined;

    const next = vi.fn(async (options?: { context?: Record<string, unknown> }) => {
        nonce = (options?.context?.security as { nonce?: string } | undefined)?.nonce;

        return { context: options?.context ?? {}, pathname: new URL(url).pathname, request, response: downstream };
    });

    const result = await run({ context: {}, next, pathname: new URL(url).pathname, request });

    return { next, nonce, result };
};

describe("securityMiddleware", () => {
    it("sets the security headers on a ctx-shaped result and keeps the context", async () => {
        const { nonce, result } = await invoke("https://app.example/chat");
        const { context, response } = result as { context: { security: { nonce: string } }; response: Response };
        const csp = response.headers.get("Content-Security-Policy") ?? "";

        expect(nonce).toBeTypeOf("string");
        expect(context.security.nonce).toBe(nonce);
        expect(directive(csp, "script-src")).toContain(`'nonce-${nonce}'`);
        expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
        expect(response.headers.get("Content-Type")).toBe("text/html");
        expect(await response.text()).toBe("<html></html>");
    });

    it("mints a fresh nonce per request", async () => {
        const first = await invoke("https://app.example/");
        const second = await invoke("https://app.example/");

        expect(first.nonce).not.toBe(second.nonce);
    });

    it("answers the artifact preview shell itself, with the shell's own CSP", async () => {
        const { next, result } = await invoke(`https://app.example${ARTIFACT_PREVIEW_PATH}`);
        const response = result as Response;

        expect(next).not.toHaveBeenCalled();
        expect(response).toBeInstanceOf(Response);
        expect(response.headers.get("Content-Security-Policy")).toBe(PREVIEW_SHELL_CSP);
        expect(response.headers.get("Content-Security-Policy")).not.toContain("nonce-");
    });
});

describe(buildCSPDirectives, () => {
    const csp = buildCSPDirectives("abc", false);

    it("uses the nonce for scripts but not for styles, where it would disable 'unsafe-inline'", () => {
        expect(directive(csp, "script-src")).toContain("'nonce-abc'");
        expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
        expect(directive(csp, "style-src")).toContain("'unsafe-inline'");
        expect(directive(csp, "style-src").join(" ")).not.toContain("nonce-");
    });

    it("allows the hosts the app really talks to", () => {
        const connect = directive(csp, "connect-src");

        expect(connect).toEqual(
            expect.arrayContaining([
                "https://backend.example",
                "wss://backend.example",
                "https://gateway.example",
                "wss://api.elevenlabs.io",
                "https://eu.i.posthog.com",
                "https://eu-assets.i.posthog.com",
            ]),
        );
        expect(directive(csp, "script-src")).toEqual(expect.arrayContaining(["https://challenges.cloudflare.com", "'wasm-unsafe-eval'"]));
        expect(directive(csp, "frame-src")).toEqual(expect.arrayContaining(["'self'", "https://proxy.mcpui.dev", "https://challenges.cloudflare.com"]));
        expect(directive(csp, "media-src")).toEqual(expect.arrayContaining(["blob:", "data:"]));
    });

    it("keeps eval and the dev HMR socket out of production", () => {
        expect(csp).not.toContain("'unsafe-eval'");
        expect(csp).not.toContain("ws://localhost");
        expect(buildCSPDirectives("abc", true)).toContain("'unsafe-eval'");
        expect(directive(buildCSPDirectives("abc", true), "connect-src")).toContain("ws://localhost:*");
    });

    it("allows local model servers on loopback — and nowhere else on the machine or LAN", () => {
        const connect = directive(csp, "connect-src");
        const loopbackSources = connect.filter((source) => source.includes("localhost") || source.includes("127.0.0.1"));

        expect(connect).toEqual(expect.arrayContaining(["http://localhost:*", "http://127.0.0.1:*"]));
        // Exactly the two, in production too: no ws://, no wildcard hosts.
        expect(loopbackSources.toSorted(byString)).toStrictEqual([...LOCAL_MODEL_CONNECT_SOURCES].toSorted(byString));
        expect(connect.join(" ")).not.toMatch(BEYOND_LOOPBACK_RE);

        // Only connect-src: loopback must not be able to serve scripts, frames or workers.
        for (const name of ["script-src", "frame-src", "worker-src", "default-src"]) {
            expect(directive(csp, name).join(" ")).not.toMatch(LOOPBACK_RE);
        }
    });

    it("does not list the local-model sources twice in development", () => {
        const connect = directive(buildCSPDirectives("abc", true), "connect-src");

        expect(connect.filter((source) => source === "http://localhost:*")).toHaveLength(1);
    });

    it("allows no public or direct-to-R2 storage host: files go through the backend's signed URLs", () => {
        expect(directive(csp, "connect-src").filter((source) => source.includes("r2."))).toEqual([]);
    });
});
