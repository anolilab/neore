/**
 * The deploy must bind every env var the backend refuses to serve without.
 *
 * `lib/env-validation.ts` runs `assertEnv()` on EVERY request (see the
 * `app.use("*")` hook in `http.ts`) and picks the strict schema whenever
 * `ENVIRONMENT !== "development"` — which is both deployed stages. Most fields
 * in that schema are a bare `z.string()`, so an ABSENT key fails validation
 * while an EMPTY one passes.
 *
 * That asymmetry is the whole problem. Thirty of the forty required keys were
 * never bound, and the failure mode is not a failed deploy: the Worker uploads,
 * reports success, and then answers 500 "Environment validation failed" to every
 * request including the health check. Nothing in the deploy path looks at the
 * schema, so nothing could have caught it.
 *
 * `alchemy.run.ts` now derives the binding list from `REQUIRED_ENV_KEYS` rather
 * than a hand-copy, which closes half of it. The half left open is the workflow:
 * a value only reaches `process.env` in CI if `deploy.yml` puts it there, so
 * adding a field to `toolApiEnvSchema` still silently breaks production unless
 * someone remembers this second file. This test is that memory.
 *
 * Cheap on purpose — two committed files, no build, no network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GATEWAY_CRONS } from "../services/llm-gateway/src/crons";
import lunoraConfig from "./lunora.config";
import { OPTIONAL_ENV_KEYS, REQUIRED_ENV_KEYS } from "./lunora/lib/env-validation";

const REPO_ROOT = join(import.meta.dirname, "..");

const alchemyScript = readFileSync(join(REPO_ROOT, "alchemy.run.ts"), "utf8");
const deployWorkflow = readFileSync(join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8");

/** An indented `KEY: value` line, matched after its indentation is trimmed. */
const ENV_KEY_LINE = /^([A-Z][A-Z0-9_]*):\s/u;
const INDENTED = /^\s/u;
const GITHUB_TOKEN_FROM_ACTIONS_SECRET = /GITHUB_TOKEN:\s*"\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}"/u;
/** Every line of alchemy.run.ts with its indentation trimmed. */
const bindingLines = alchemyScript.split("\n").map((line) => line.trim());

const GATEWAY_BACKEND_ORIGIN = /LUNORA_URL:\s*requireEnv\("BACKEND_PUBLIC_ORIGIN"\)/u;
const GATEWAY_CRONS_PASSED = /crons: GATEWAY_CRONS/u;

/** `wrangler.jsonc` with its comments stripped (string contents kept), as `deploy-bindings.test.ts` reads it. */
const readJsonc = (path: string): unknown =>
    JSON.parse(readFileSync(path, "utf8").replaceAll(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => (match.startsWith('"') ? match : "")));

/**
 * Keys the deploy computes rather than reads, or reads under another name.
 *
 * Each one is aliased deliberately and the alias is load-bearing:
 * `SITE_URL` is fed from the same secret the app is BUILT with, because the app
 * and the backend disagreeing about the origin fails silently (every bearer
 * token verifies as anonymous). `ENVIRONMENT` is derived from the stage. Add to
 * this map only with a reason of that kind.
 */
const DERIVED_OR_ALIASED: Record<string, string> = {
    ENVIRONMENT: "derived from the Alchemy stage",
    SITE_URL: "fed from VITE_SITE_URL, the value the app is built with",
};

/**
 * Optional keys the workflow deliberately does NOT feed, each with its reason.
 *
 * `optionalEnvPassthrough` binds an optional key only when the deploy step's
 * environment has a value, so a key missing from deploy.yml can never be
 * turned on — Web Push shipped that way. Keys bound explicitly in
 * alchemy.run.ts are recognised on their own and need no entry here.
 */
const OPTIONAL_NOT_FED: Record<string, string> = {
    BROWSERBASE_API_KEY: "dead: the browser tool runs on the browser-renderer worker only",
    BROWSERBASE_PROJECT_ID: "dead: the browser tool runs on the browser-renderer worker only",
};

/** Env keys declared on the Alchemy deploy step. */
const workflowEnvKeys = (): Set<string> => {
    const stepStart = deployWorkflow.indexOf('id: "alchemy"');

    expect(stepStart, 'deploy.yml no longer has a step with id "alchemy"').toBeGreaterThan(-1);

    const stepEnd = deployWorkflow.indexOf("run: |", stepStart);
    const block = deployWorkflow.slice(stepStart, stepEnd);

    // Line by line rather than one multiline `^\s+KEY:` pattern, whose leading
    // `\s+` can backtrack across line breaks.
    return new Set(
        block
            .split("\n")
            .filter((line) => INDENTED.test(line))
            .map((line) => ENV_KEY_LINE.exec(line.trimStart())?.[1])
            .filter((key): key is string => key !== undefined),
    );
};

describe("deploy env bindings", () => {
    it("binds the required-env pass-through on the backend Worker", () => {
        // The spread is what turns REQUIRED_ENV_KEYS into actual bindings. Without
        // it the import is dead code and the outage is back.
        expect(alchemyScript).toContain("...requiredEnvPassthrough");
        expect(alchemyScript).toContain("REQUIRED_ENV_KEYS.map");
    });

    it.each(REQUIRED_ENV_KEYS)("passes %s to the deploy step", (key) => {
        if (key in DERIVED_OR_ALIASED) {
            return;
        }

        expect(
            workflowEnvKeys(),
            `${key} is required by the production env schema but .github/workflows/deploy.yml never sets it, so it reaches the Worker as ABSENT and every request 500s`,
        ).toContain(key);
    });

    it.each(OPTIONAL_ENV_KEYS)("lets the deploy turn on optional %s", (key) => {
        if (Object.hasOwn(OPTIONAL_NOT_FED, key) || bindingLines.some((line) => line.startsWith(`${key}: `))) {
            return;
        }

        expect(
            workflowEnvKeys(),
            `${key} is an optional backend key, but .github/workflows/deploy.yml never sets it, so optionalEnvPassthrough never sees a value and the feature can never be enabled on a deploy`,
        ).toContain(key);
    });

    it("keeps OPTIONAL_NOT_FED honest", () => {
        // A stale entry would silently exempt a key that later comes back.
        for (const key of Object.keys(OPTIONAL_NOT_FED)) {
            expect(OPTIONAL_ENV_KEYS).toContain(key);
            expect(workflowEnvKeys()).not.toContain(key);
        }
    });

    it("never sources the tool GITHUB_TOKEN from the reserved Actions secret", () => {
        // `secrets.GITHUB_TOKEN` is the workflow's own ephemeral token. Binding it
        // would ship a credential into the Worker that expires minutes later, and
        // GitHub will not let a real secret be stored under that name anyway.
        expect(deployWorkflow).not.toMatch(GITHUB_TOKEN_FROM_ACTIONS_SECRET);
    });

    it("keeps ALCHEMY_PASSWORD in the up-front guard and in the workflow", () => {
        // Alchemy has no default for it; unset, the run dies mid-graph at the
        // first `alchemy.secret()` rather than at the guard.
        expect(alchemyScript).toContain('"ALCHEMY_PASSWORD"');
        expect(workflowEnvKeys()).toContain("ALCHEMY_PASSWORD");
    });

    it("does not double-prefix the gateway's ALLOWED_ORIGINS", () => {
        // `website.url` is already `https://…`; `https://${website.url}` produced
        // an origin that could never match a request's Origin header, CORS-
        // rejecting every browser call to the gateway.
        // eslint-disable-next-line no-template-curly-in-string -- the needle IS template-literal source text searched for in alchemy.run.ts
        expect(alchemyScript).not.toContain("`https://${website.url}");
    });

    /**
     * The sibling Workers are SERVICE BINDINGS, declared once in
     * `backend/lunora.config.ts`. Lunora derives the binding name
     * (`SERVICE_<KEY>`) and writes it into `backend/wrangler.jsonc`, which is
     * what dev runs on; Alchemy, which deploys, does not read that file — so the
     * same names must be bound in alchemy.run.ts by hand, or every call fails at
     * runtime naming a binding that a green deploy never created.
     */
    const SERVICES = [
        { key: "browserRenderer", private: true, worker: "browserRenderer" },
        { key: "documentParser", private: true, worker: "documentParser" },
        { key: "llmGateway", private: false, worker: "llmGateway" },
        { key: "nsfwChecker", private: true, worker: "nsfwChecker" },
    ] as const;

    const bindingName = (key: string): string => `SERVICE_${key.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/gu, "_").toUpperCase()}`;

    const backendWrangler = readJsonc(join(REPO_ROOT, "backend/wrangler.jsonc")) as {
        services?: { binding: string; entrypoint?: string; service: string }[];
    };
    /** The `services[]` entries Lunora's reconcile owns (and would rewrite). */
    const lunoraOwnedServices = (
        JSON.parse(readFileSync(join(REPO_ROOT, "backend/package.json"), "utf8")) as { lunora?: { services?: { services?: string[] } } }
    ).lunora?.services?.services;

    it("declares exactly the services the backend calls", () => {
        // `embeddings` is deliberately absent: nothing in the backend calls it.
        const byName = (a: string, b: string): number => a.localeCompare(b);

        expect(Object.keys(lunoraConfig.services).toSorted(byName)).toEqual(SERVICES.map((service) => service.key).toSorted(byName));
    });

    it.each(SERVICES)("binds $key as a service binding on both the dev and the deploy side", ({ key, worker }) => {
        const binding = bindingName(key);
        const declared = lunoraConfig.services[key] as { dir: string; entrypoint?: string };
        const wranglerEntry = backendWrangler.services?.find((entry) => entry.binding === binding);

        // The gateway's entrypoint lives only in its hand-written wrangler entry (see lunora.config.ts).
        const entrypoint = key === "llmGateway" ? "InternalApi" : declared.entrypoint;

        // Dev: Lunora's reconcile wrote it (run `lunora dev` / `pnpm run prepare:deploy` after editing lunora.config.ts).
        expect(wranglerEntry, `backend/wrangler.jsonc has no services[] entry for ${binding}`).toBeDefined();
        expect(wranglerEntry?.entrypoint).toBe(entrypoint);

        // Deploy: the same name, on the backend Worker, pointing at the same Worker (and entrypoint).
        const deployed = entrypoint === undefined ? `${binding}: ${worker},` : `${binding}: Worker.experimentalEntrypoint(${worker}, "${entrypoint}"),`;

        expect(bindingLines).toContain(deployed);
    });

    it.each(SERVICES.filter((service) => service.private))("keeps $key private, with no URL or signing secret left behind", ({ key, worker }) => {
        const declared = lunoraConfig.services[key] as { dir: string };
        const serviceWrangler = readJsonc(join(REPO_ROOT, "backend", declared.dir, "wrangler.jsonc")) as { workers_dev?: boolean };
        const prefix = bindingName(key).replace("SERVICE_", "");
        const workerBlock = alchemyScript.slice(alchemyScript.indexOf(`export const ${worker} = await Worker(`));

        // No public URL on either side — wrangler for dev/`lunora doctor`, Alchemy for the deploy.
        expect(serviceWrangler.workers_dev).toBe(false);
        expect(workerBlock.slice(0, workerBlock.indexOf("bindings:"))).toContain("url: false,");

        // The binding is the auth: the old per-service HMAC secret and URL are gone everywhere.
        for (const dead of [`${prefix}_SIGNING_SECRET`, `${prefix}_URL`]) {
            expect(alchemyScript).not.toContain(dead);
            expect(workflowEnvKeys()).not.toContain(dead);
            expect([...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS]).not.toContain(dead);
        }
    });

    it("binds the gateway's InternalApi entrypoint, never its public fetch handler", () => {
        // The gateway is public (the browser posts to `/v1/*`); its `/internal/*`
        // routes answer only the `InternalApi` entrypoint, which no route serves.
        // The entrypoint is set in a HAND-WRITTEN wrangler entry Lunora does not
        // own — declaring it in lunora.config.ts would type the binding from the
        // gateway's sources and drag them into every consumer's tsc.
        expect(lunoraConfig.services.llmGateway).toEqual({ dir: "../services/llm-gateway" });
        expect(backendWrangler.services?.find((entry) => entry.binding === "SERVICE_LLM_GATEWAY")?.entrypoint).toBe("InternalApi");
        expect(lunoraOwnedServices).not.toContain("SERVICE_LLM_GATEWAY");
        expect(bindingLines).not.toContain("SERVICE_LLM_GATEWAY: llmGateway,");
    });

    it("keeps LLM_GATEWAY_SIGNING_SECRET on both ends for the gateway -> backend direction", () => {
        // Chunk polling, usage reports, key validation and stream tokens are still
        // HMAC-signed with it; only backend -> gateway moved to the binding.
        const binding = 'alchemy.secret(requireEnv("LLM_GATEWAY_SIGNING_SECRET"))';

        expect(workflowEnvKeys()).toContain("LLM_GATEWAY_SIGNING_SECRET");
        expect(bindingLines).toContain(`SIGNING_SECRET: ${binding},`);
        expect(bindingLines).toContain(`LLM_GATEWAY_SIGNING_SECRET: ${binding},`);
        // The backend has no gateway URL any more: it has the binding.
        expect(bindingLines.some((line) => line.startsWith("LLM_GATEWAY_URL:"))).toBe(false);
    });

    it("keeps the uncalled embeddings Worker unbound, private and secretless", () => {
        // Nothing calls it; a binding, a URL or a secret for it would be dead config.
        const serviceWrangler = readJsonc(join(REPO_ROOT, "services/embeddings/wrangler.jsonc")) as { workers_dev?: boolean };
        const workerBlock = alchemyScript.slice(alchemyScript.indexOf("export const embeddingsWorker = await Worker("));

        expect(backendWrangler.services?.some((entry) => entry.service === "embeddings")).toBe(false);
        expect(serviceWrangler.workers_dev).toBe(false);
        expect(workerBlock.slice(0, workerBlock.indexOf("bindings:"))).toContain("url: false,");

        for (const dead of ["EMBEDDINGS_WORKER_SIGNING_SECRET", "EMBEDDINGS_WORKER_URL"]) {
            expect(alchemyScript).not.toContain(dead);
            expect(workflowEnvKeys()).not.toContain(dead);
        }
    });

    it("gives the gateway the backend origin it forwards to", () => {
        // Without it `/v1/chat` answers 500 "Gateway not configured" — and the
        // browser reaches the backend only through this worker.
        expect(alchemyScript).toMatch(GATEWAY_BACKEND_ORIGIN);
    });

    it("deploys the gateway crons wrangler.jsonc runs in dev", () => {
        // Alchemy does not read wrangler.jsonc: without `crons` the pricing refresh,
        // usage aggregation and circuit-breaker reset never fire in production.
        const wrangler = readJsonc(join(REPO_ROOT, "services/llm-gateway/wrangler.jsonc")) as { triggers?: { crons?: string[] } };

        const byText = (a: string, b: string): number => a.localeCompare(b);

        expect(wrangler.triggers?.crons?.toSorted(byText)).toStrictEqual(GATEWAY_CRONS.toSorted(byText));
        expect(alchemyScript).toMatch(GATEWAY_CRONS_PASSED);
    });
});
