/**
 * Extract OpenAPI specs from running service dev servers.
 *
 * Usage:
 *   1. Start each service STANDALONE (`pnpm dev:llm-gateway`, `pnpm dev:nsfw-checker`). Inside the backend's `lunora dev` session the
 *      services are service bindings with no port of their own, so `pnpm dev`
 *      alone serves only the gateway.
 *   2. Run: pnpm --filter @neore/service-sdk generate:extract
 *
 * This fetches /openapi.json from each service that uses @hono/zod-openapi
 * and saves the specs to the openapi/ directory for SDK generation.
 *
 * Note: browser-renderer and embeddings use plain Hono (not OpenAPIHono), and
 * document-parser is a Rust Worker, so their specs are maintained manually in
 * openapi/*.json.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVICES = [
    { name: "llm-gateway", port: 8787 },
    { name: "nsfw-checker", port: 8791 },
] as const;

const outputDir = resolve(import.meta.dirname, "../openapi");

async function extractSpec(service: (typeof SERVICES)[number]): Promise<void> {
    const url = `http://localhost:${service.port}/openapi.json`;

    console.log(`Fetching ${service.name} spec from ${url}...`);

    try {
        const response = await fetch(url);

        if (!response.ok) {
            console.error(`  Failed (${response.status}): ${service.name} — is the service running?`);
            return;
        }

        const spec = await response.json();
        const outputPath = resolve(outputDir, `${service.name}.json`);

        writeFileSync(outputPath, JSON.stringify(spec, null, 4) + "\n");
        console.log(`  Saved: ${outputPath}`);
    } catch (error) {
        console.error(`  Error fetching ${service.name}:`, error instanceof Error ? error.message : String(error));
        console.error(`  Make sure the service is running: pnpm --filter=${service.name} dev`);
    }
}

async function main(): Promise<void> {
    console.log("Extracting OpenAPI specs from running services...\n");

    const results = await Promise.allSettled(SERVICES.map(extractSpec));

    const failures = results.filter((r) => r.status === "rejected");

    if (failures.length > 0) {
        console.warn(`\n${failures.length} service(s) failed. Make sure they are running.`);
    }

    console.log("\nDone. Run `pnpm --filter @neore/service-sdk generate` to regenerate SDK clients.");
}

main().catch(console.error);
