/**
 * Generate SDK clients from OpenAPI specs using @hey-api/openapi-ts.
 *
 * Usage:
 *   pnpm --filter @neore/service-sdk generate
 *
 * This reads OpenAPI specs from the openapi/ directory and generates
 * TypeScript SDK clients into src/generated/ for each service.
 */
import { createClient } from "@hey-api/openapi-ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVICES = ["llm-gateway", "document-parser", "nsfw-checker", "browser-renderer", "embeddings"] as const;

const rootDir = resolve(import.meta.dirname, "..");

async function generateForService(service: string): Promise<void> {
    const specPath = resolve(rootDir, `openapi/${service}.json`);

    if (!existsSync(specPath)) {
        console.warn(`  Skipping ${service}: no spec found at ${specPath}`);
        console.warn(`  Run 'pnpm --filter @neore/service-sdk generate:extract' first.`);
        return;
    }

    const outputPath = resolve(rootDir, `src/generated/${service}`);

    console.log(`Generating SDK for ${service}...`);

    await createClient({
        input: specPath,
        output: outputPath,
        plugins: [
            {
                name: "@hey-api/typescript",
                enums: "javascript",
            },
            {
                name: "@hey-api/sdk",
                asClass: false,
                operationId: true,
            },
            {
                name: "@hey-api/client-fetch",
            },
        ],
    });

    // Post-process: rename the generated `Options` type to `SdkOptions`.
    //
    // The emitted client declares its own `Options`, and packem's DTS bundle would
    // otherwise merge the two into `Options` / `Options$1` — legal, but the numbered
    // one is what shows up in consumers' hover text.
    //
    // `index.ts` re-exports the name too, so both files have to move together or the
    // barrel points at a type `sdk.gen.ts` no longer exports.
    const sdkGenPath = resolve(outputPath, "sdk.gen.ts");

    if (existsSync(sdkGenPath)) {
        let content = readFileSync(sdkGenPath, "utf-8");

        content = content
            .replace(/^export type Options</m, "export type SdkOptions<")
            .replace(/\boptions: Options</g, "options: SdkOptions<")
            .replace(/\boptions\?: Options</g, "options?: SdkOptions<");
        writeFileSync(sdkGenPath, content);
        console.log(`  Post-processed: renamed Options → SdkOptions in sdk.gen.ts`);
    }

    const indexPath = resolve(outputPath, "index.ts");

    if (existsSync(indexPath)) {
        // `type Options` sits in the middle of the value export list, hence the optional `type` prefix.
        const content = readFileSync(indexPath, "utf-8").replace(/([{,]\s*)(type\s+)?Options(\s*[,}])/g, "$1$2SdkOptions$3");

        writeFileSync(indexPath, content);
        console.log(`  Post-processed: re-exported SdkOptions from index.ts`);
    }

    console.log(`  Generated: ${outputPath}`);
}

async function main(): Promise<void> {
    console.log("Generating SDK clients from OpenAPI specs...\n");

    for (const service of SERVICES) {
        await generateForService(service);
    }

    console.log("\nDone. SDK clients generated in src/generated/");
}

main().catch(console.error);
