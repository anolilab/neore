#!/usr/bin/env node
/**
 * Interactive development setup script.
 *
 * Gets a new developer from zero to a running app with minimal configuration.
 * Seeds every env file from its .env.example, generates cryptographic keys
 * (the backend <-> LLM gateway pair is shared so its HMAC verifies), and writes
 * backend defaults. The backend reaches its sibling Workers over SERVICE
 * BINDINGS (`backend/lunora.config.ts`), so there are no service URLs or
 * per-service signing secrets to write.
 *
 * Usage: pnpm dev:setup
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// ─── Helpers ────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = async (question, defaultValue) => {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue || "";
};

const readEnvFile = (filePath) => {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    const content = fs.readFileSync(filePath, "utf8");
    const env = {};

    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex);
        let value = trimmed.slice(eqIndex + 1);
        // Strip surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }

    return env;
};

const writeEnvFile = (filePath, env) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = Object.entries(env).map(([key, value]) => {
        // Quote values that contain characters which could be mangled by shell
        // parsing (=, spaces, #, etc.) — common with base64-encoded keys
        const needsQuoting = /[=\s#"'\\$`!]/.test(value);
        return needsQuoting ? `${key}="${value}"` : `${key}=${value}`;
    });
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
};

const generateKey = (bytes = 32, encoding = "base64") => crypto.randomBytes(bytes).toString(encoding);

/**
 * The Lunora backend's dev port. Fixed in `backend/wrangler.jsonc` (`dev.port`),
 * `backend/project.json` (`--worker-port`) and the `PUBLIC_ORIGIN` this script
 * writes to `backend/.dev.vars`; `VITE_LUNORA_URL` must match it.
 * No service may claim it.
 */
const BACKEND_DEV_PORT = 8788;

/**
 * Keys that used to live in `apps/web/.env` and are now dead. `wrangler types`
 * derives `apps/web/worker-configuration.d.ts` from this file (the app's
 * `wrangler.jsonc` has an empty `vars: {}`), so a stale key is not inert — it
 * gets baked back into a COMMITTED generated file on the next `cf:typegen`,
 * which `apps/web`'s postinstall runs automatically. That is how a checkout can
 * spontaneously regress `LUNORA_*` back to a retired name with no source change.
 *
 * Only list keys with zero references left in `apps/web`. This prunes
 * `apps/web/.env` and nothing else — `apps/browser-extension` has its own file,
 * so a key listed here is not removed from it. (The extension used to read
 * the old backend URL pair; it is on `VITE_LUNORA_URL` now, like the web app.)
 */
const DEAD_WEB_ENV_KEYS = [
    // Superseded by VITE_LUNORA_URL, which serves both /_lunora/rpc and /api/auth/*.
    // Collapsed into VITE_LUNORA_URL in 6080ae07 (one Worker serves both origins).
    "VITE_LUNORA_SITE_URL",
    // Nothing ever read it.
    "LUNORA_DEPLOYMENT",
    // Zero references anywhere in the repo.
    "VITE_FEATUREBASE_ORG",
];

/**
 * Live keys that must EXIST in `apps/web/.env`, even with no value.
 *
 * Same `wrangler types` mechanism as {@link DEAD_WEB_ENV_KEYS}, mirrored: a key
 * missing locally is silently dropped from the committed
 * `worker-configuration.d.ts` on the next regen, deleting a declaration the app
 * actually uses. An empty value is safe — `apps/web/src/lib/env.ts` sets
 * `emptyStringAsUndefined: true`, so `KEY=` is indistinguishable from unset, and
 * typegen only reads key NAMES. Only list keys that are optional in env.ts; a
 * required one needs a real value and belongs with the aligners below.
 */
const REQUIRED_WEB_ENV_KEYS = [
    // Optional in env.ts, but 17 live references across the app.
    "VITE_TURNSTILE_SITE_KEY",
];

const relPath = (absolute) => path.relative(rootDir, absolute);

/**
 * Load an env file; if missing, seed it from a .env.example sibling when one exists.
 * Returns { env, created: boolean }.
 */
const loadOrSeed = (targetPath, examplePath) => {
    if (fs.existsSync(targetPath)) {
        return { env: readEnvFile(targetPath), created: false };
    }

    if (examplePath && fs.existsSync(examplePath)) {
        const env = readEnvFile(examplePath);
        return { env, created: true };
    }

    return { env: {}, created: true };
};

/**
 * Apply key=value pairs to env *only if missing*. Mutates env in place.
 * Returns true if anything changed.
 */
const applyDefaults = (env, defaults) => {
    let changed = false;

    for (const [key, value] of Object.entries(defaults)) {
        if (!env[key] && value !== undefined && value !== "") {
            env[key] = value;
            changed = true;
        }
    }

    return changed;
};

// ─── Main ───────────────────────────────────────────────────────────────────────

const main = async () => {
    console.log("\n=== Neore Chat v2 — Development Setup ===\n");

    // 1. Check Node version
    const nodeVersion = process.versions.node;
    const [major] = nodeVersion.split(".").map(Number);

    if (major < 22) {
        console.error(`Node.js 22+ is required. You have ${nodeVersion}.`);
        process.exit(1);
    }

    console.log(`Node.js ${nodeVersion}`);

    // 2. Check pnpm install
    if (!fs.existsSync(path.join(rootDir, "node_modules"))) {
        console.log("\nnode_modules not found. Run 'pnpm install' first.");
        process.exit(1);
    }

    // ── 3. Service .dev.vars ───────────────────────────────────────────────────
    //
    // The backend calls llm-gateway, document-parser, browser-renderer and
    // nsfw-checker over service bindings: `lunora dev` runs all four inside the
    // backend's own `wrangler dev` session (each loads its own `.dev.vars`), and
    // there is no URL or HMAC between them. Only the gateway still shares a secret
    // with the backend, for the OTHER direction: its calls back to the backend
    // (chunk polling, usage reports, key validation) and the stream tokens the
    // backend mints are HMAC-signed. embeddings keeps its own secret because it
    // still verifies HMAC — nothing calls it, so it was left out of the move.

    console.log("\nSeeding service .dev.vars files...");

    const services = [
        {
            name: "llm-gateway",
            file: path.join(rootDir, "services/llm-gateway/.dev.vars"),
            example: path.join(rootDir, "services/llm-gateway/.env.example"),
            secretKey: "SIGNING_SECRET",
            backendSecretKey: "LLM_GATEWAY_SIGNING_SECRET",
            extraDefaults: {
                NODE_ENV: "development",
                APP_NAME: "llm-gateway",
                APP_VERSION: "0.0.0-dev",
                // 8788, not 3210. 3210 was the previous backend's local HTTP
                // port and the Lunora backend does not listen there — so the gateway's
                // forward, chunk poll and API-key validation all hit a closed
                // port in local dev. Must match the backend's PUBLIC_ORIGIN in
                // `backend/wrangler.jsonc`.
                LUNORA_URL: `http://localhost:${BACKEND_DEV_PORT}`,
            },
        },
        {
            name: "document-parser",
            file: path.join(rootDir, "services/document-parser/.dev.vars"),
            example: path.join(rootDir, "services/document-parser/.env.example"),
            secretKey: null, // service binding only
            // A Rust Worker that reads no env at all; listed only so the stale secret is dropped.
            staleKeys: ["PARSER_SIGNING_SECRET"],
            extraDefaults: {},
        },
        {
            name: "browser-renderer",
            file: path.join(rootDir, "services/browser-renderer/.dev.vars"),
            example: path.join(rootDir, "services/browser-renderer/.env.example"),
            secretKey: null, // service binding only
            staleKeys: ["SIGNING_SECRET"],
            extraDefaults: { NODE_ENV: "development" },
        },
        {
            name: "embeddings",
            file: path.join(rootDir, "services/embeddings/.dev.vars"),
            example: path.join(rootDir, "services/embeddings/.env.example"),
            secretKey: "SIGNING_SECRET", // still HMAC; not called by the backend
            extraDefaults: { NODE_ENV: "development" },
        },
        {
            name: "nsfw-checker",
            file: path.join(rootDir, "services/nsfw-checker/.dev.vars"),
            example: path.join(rootDir, "services/nsfw-checker/.env.example"),
            secretKey: null, // service binding only
            staleKeys: ["NSFW_SIGNING_SECRET"],
            extraDefaults: { NODE_ENV: "development" },
        },
    ];

    // Generate or reuse each service's secret, persist .dev.vars
    for (const svc of services) {
        const { env, created } = loadOrSeed(svc.file, svc.example);
        let changed = created;

        if (!svc.secretKey) {
            console.log(`  [binding]   ${svc.name}: no secret (reached over a service binding)`);
        } else if (!env[svc.secretKey]) {
            env[svc.secretKey] = generateKey(32, "hex");
            changed = true;
            console.log(`  [generated] ${svc.name}: ${svc.secretKey}`);
        } else {
            console.log(`  [reused]    ${svc.name}: ${svc.secretKey}`);
        }

        for (const key of svc.staleKeys ?? []) {
            if (key in env) {
                delete env[key];
                changed = true;
                console.log(`  [drop]      ${svc.name}: ${key} (the service binding replaced it)`);
            }
        }

        if (applyDefaults(env, svc.extraDefaults)) {
            changed = true;
        }

        if (changed) {
            writeEnvFile(svc.file, env);
            console.log(`              wrote ${relPath(svc.file)}`);
        }

        // Stash secret on the descriptor for the backend pairing pass below
        svc.resolvedSecret = svc.secretKey ? env[svc.secretKey] : undefined;
    }

    // ── 4. backend/.dev.vars ───────────────────────────────────────────────────

    console.log("\nUpdating backend/.dev.vars...");

    // `backend/.dev.vars` + `.dev.vars.example`: the file the backend reads,
    // holding the encryption keys, service signing secrets and the admin email.
    const backendEnvPath = path.join(rootDir, "backend/.dev.vars");
    const backendExamplePath = path.join(rootDir, "backend/.dev.vars.example");
    const { env: backendEnv } = loadOrSeed(backendEnvPath, backendExamplePath);
    let backendChanged = false;

    const setBackendDefault = (key, value) => {
        if (!backendEnv[key]) {
            backendEnv[key] = value;
            backendChanged = true;
            console.log(`  [set]   ${key}`);
        } else {
            console.log(`  [keep]  ${key}`);
        }
    };

    const setBackendAligned = (key, value) => {
        if (backendEnv[key] && backendEnv[key] !== value) {
            console.log(`  [align] ${key} (was different from service value — overwriting to keep HMAC in sync)`);
        } else if (backendEnv[key] === value) {
            console.log(`  [keep]  ${key}`);
            return;
        } else {
            console.log(`  [set]   ${key}`);
        }

        backendEnv[key] = value;
        backendChanged = true;
    };

    // The SchedulerDO reads `LUNORA_ORIGIN_URL` from its own env at fire time —
    // `.scheduler({ origin })` in `backend/src/server.ts` configures the APP, not
    // the Durable Object, so without this every `ctx.scheduler.runAfter/runAt`
    // fails with "LUNORA_ORIGIN_URL env binding must be set on the SchedulerDO".
    // That is 34 call sites (memory extraction, stream timeouts, GDPR steps), and
    // it surfaces as a 500 from whichever procedure happened to schedule.
    //
    // It lives here rather than in `wrangler.jsonc` because `lunora build` blocks
    // on a loopback address there — correctly, since that value would ship to a
    // deploy. Must equal PUBLIC_ORIGIN: it is the origin the scheduler calls back on.
    console.log("\n  Scheduler:");
    setBackendAligned("LUNORA_ORIGIN_URL", `http://localhost:${BACKEND_DEV_PORT}`);

    // PUBLIC_ORIGIN moved here from `wrangler.jsonc` for the same reason: the
    // `lunora build` loopback gate covers it too. The backend refuses to start
    // without it, and it must equal VITE_LUNORA_URL (see step 5).
    console.log("\n  Public origin:");
    setBackendAligned("PUBLIC_ORIGIN", `http://localhost:${BACKEND_DEV_PORT}`);

    // Cryptographic keys
    console.log("\n  Cryptographic keys:");
    for (const [key, gen] of [
        ["ENCRYPTION_KEY", () => generateKey(32, "base64")],
        ["CONNECTOR_ENCRYPTION_KEY", () => generateKey(32, "hex")],
        ["BETTER_AUTH_SECRET", () => generateKey(32, "base64")],
        // Signs `ctx.storage` download URLs; without it every signed download fails.
        ["STORAGE_SIGNING_SECRET", () => generateKey(32, "hex")],
        // Unlocks `POST /e2e/invitations`, which the e2e suite seeds through
        // (`backend/lunora/auth/e2e-seed-http.ts`). Local only: the deploy binds none.
        ["E2E_SEED_TOKEN", () => generateKey(32, "hex")],
    ]) {
        if (!backendEnv[key]) {
            backendEnv[key] = gen();
            backendChanged = true;
            console.log(`  [gen]   ${key}`);
        } else {
            console.log(`  [keep]  ${key}`);
        }
    }

    // Web Push VAPID keys — a PAIR, so both are (re)generated when either is missing.
    // Optional in production (push is simply off without them); generated here so
    // push works locally in a production build. Format: base64url, the public key
    // an uncompressed P-256 point, the private key its scalar `d`.
    if (!backendEnv["VAPID_PUBLIC_KEY"] || !backendEnv["VAPID_PRIVATE_KEY"]) {
        const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const jwk = privateKey.export({ format: "jwk" });
        const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);

        backendEnv["VAPID_PUBLIC_KEY"] = point.toString("base64url");
        backendEnv["VAPID_PRIVATE_KEY"] = jwk.d;
        backendChanged = true;
        console.log("  [gen]   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY");
    } else {
        console.log("  [keep]  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY");
    }

    // JWKS
    if (!backendEnv["JWKS"]) {
        console.log("\n  JWKS not set — will use dynamic JWKS fetching (slower, ~100-400ms overhead per query).");
        console.log("  Run 'pnpm env:sync:auth' after configuring auth to generate static JWKS.");
    } else if (backendEnv["JWKS"] === '{"keys":[]}') {
        console.log("\n  JWKS placeholder is empty — removing it (breaks JWT validation).");
        console.log("  Run 'pnpm env:sync:auth' to generate valid JWKS.");
        delete backendEnv["JWKS"];
        backendChanged = true;
    } else {
        console.log("\n  [keep]  JWKS");
    }

    // Development defaults
    console.log("\n  Development defaults:");
    setBackendDefault("ENVIRONMENT", "development");
    setBackendDefault("SITE_URL", "http://localhost:5173");
    setBackendDefault("ADMIN", "");
    // `@lunora/mail` requires a sender even when `lunora dev` only captures.
    setBackendDefault("MAIL_FROM", "Neore <noreply@neore.localhost>");

    // The gateway's paired secret (gateway -> backend calls, stream tokens).
    console.log("\n  LLM gateway secret (paired):");
    for (const svc of services) {
        if (!svc.backendSecretKey) continue;

        setBackendAligned(svc.backendSecretKey, svc.resolvedSecret);
    }

    // Dead since the move to service bindings: the backend has no service URLs
    // and signs nothing to a service. Removed so a stale value cannot mislead.
    console.log("\n  Service bindings (no URLs or secrets):");
    for (const key of [
        "LLM_GATEWAY_URL",
        "BROWSER_RENDERER_URL",
        "BROWSER_RENDERER_SIGNING_SECRET",
        "DOCUMENT_PARSER_URL",
        "DOCUMENT_PARSER_SIGNING_SECRET",
        "EMBEDDINGS_WORKER_URL",
        "EMBEDDINGS_WORKER_SIGNING_SECRET",
        "NSFW_CHECKER_URL",
        "NSFW_CHECKER_SIGNING_SECRET",
    ]) {
        if (key in backendEnv) {
            delete backendEnv[key];
            backendChanged = true;
            console.log(`  [drop]  ${key}`);
        }
    }

    // Admin email
    const adminEmail = await ask("\n  Your email (for admin role, leave blank to skip)", backendEnv["ADMIN"]);

    if (adminEmail && adminEmail !== backendEnv["ADMIN"]) {
        backendEnv["ADMIN"] = adminEmail;
        backendChanged = true;
    }

    // Browser extension. Optional, and only asked on a terminal: a piped or CI
    // run keeps whatever is there (possibly nothing, which just means the
    // extension cannot sign in). The id appears on the extension's card once
    // apps/browser-extension/dist is loaded unpacked at chrome://extensions.
    if (process.stdin.isTTY && !backendEnv["TRUSTED_EXTENSION_ORIGINS"]) {
        const extensionId = await ask("\n  Unpacked browser extension ID (chrome://extensions, leave blank to skip)");

        if (/^[a-p]{32}$/.test(extensionId)) {
            backendEnv["TRUSTED_EXTENSION_ORIGINS"] = `chrome-extension://${extensionId}`;
            backendChanged = true;
            console.log("  [set]   TRUSTED_EXTENSION_ORIGINS");
        } else if (extensionId) {
            console.log("  [skip]  TRUSTED_EXTENSION_ORIGINS — an extension id is 32 letters a–p");
        }
    }

    // AI provider key
    console.log("\n  AI Provider:");
    console.log("    At least one provider key is needed for chat to work.");
    console.log("    OpenRouter is recommended (supports 100+ models): https://openrouter.ai/keys");

    if (!backendEnv["OPENROUTER_API_KEY"]) {
        const orKey = await ask("\n    OPENROUTER_API_KEY (paste key or press Enter to skip)");

        if (orKey) {
            backendEnv["OPENROUTER_API_KEY"] = orKey;
            backendChanged = true;
        }
    } else {
        console.log("    [keep]  OPENROUTER_API_KEY");
    }

    if (backendChanged) {
        writeEnvFile(backendEnvPath, backendEnv);
        console.log(`\n  Wrote ${relPath(backendEnvPath)}`);
    } else {
        console.log("\n  No changes needed.");
    }

    // ── 5. apps/web/.env ───────────────────────────────────────────────────────

    console.log("\nUpdating apps/web/.env...");

    const webEnvPath = path.join(rootDir, "apps/web/.env");
    const webExamplePath = path.join(rootDir, "apps/web/.env.example");
    const { env: webEnv, created: webCreated } = loadOrSeed(webEnvPath, webExamplePath);
    let webChanged = webCreated;

    if (webCreated) {
        console.log(`  [created] ${relPath(webEnvPath)} from .env.example`);
    }

    for (const key of DEAD_WEB_ENV_KEYS) {
        if (key in webEnv) {
            console.log(`  [prune]   ${key} (dead — would be regenerated into worker-configuration.d.ts)`);
            delete webEnv[key];
            webChanged = true;
        }
    }

    for (const key of REQUIRED_WEB_ENV_KEYS) {
        if (!(key in webEnv)) {
            console.log(`  [add]     ${key}= (live key, empty — keeps it in worker-configuration.d.ts)`);
            webEnv[key] = "";
            webChanged = true;
        }
    }

    const setWebAligned = (key, value) => {
        if (webEnv[key] === value) {
            console.log(`  [keep]    ${key}`);
            return;
        }

        if (webEnv[key]) {
            console.log(`  [align]   ${key} (was ${webEnv[key]} → ${value})`);
        } else {
            console.log(`  [set]     ${key}=${value}`);
        }

        webEnv[key] = value;
        webChanged = true;
    };

    // Browser hits the gateway through Vite's /llm-gateway proxy on :5173.
    // This means same-origin (no CORS) and a single port for the dev experience.
    setWebAligned("VITE_LLM_GATEWAY_URL", "http://localhost:5173/llm-gateway");

    // VITE_LUNORA_URL is REQUIRED by apps/web/src/lib/env.ts (a bare `z.url()`), so
    // the app refuses to boot without it — and this step used to write only the
    // gateway URL, which is how a seeded .env still failed validation on `pnpm dev`.
    //
    // It must equal the backend's PUBLIC_ORIGIN (backend/wrangler.jsonc, :8788).
    // `server.ts` pins jwtVerify to PUBLIC_ORIGIN and the backend mints tokens with
    // whatever host it was reached on, so a drift here is not a 404 — every bearer
    // token silently verifies as anonymous and the app just looks signed-out.
    // Hence align rather than default: a stale value is worse than a missing one.
    setWebAligned("VITE_LUNORA_URL", `http://localhost:${BACKEND_DEV_PORT}`);

    // Mirrors the backend's own SITE_URL default. Also required by env.ts.
    if (!webEnv["VITE_SITE_URL"]) {
        webEnv["VITE_SITE_URL"] = backendEnv["SITE_URL"] || "http://localhost:5173";
        webChanged = true;
        console.log(`  [set]     VITE_SITE_URL=${webEnv["VITE_SITE_URL"]}`);
    } else {
        console.log("  [keep]    VITE_SITE_URL");
    }

    if (webChanged) {
        writeEnvFile(webEnvPath, webEnv);
        console.log(`  Wrote ${relPath(webEnvPath)}`);
    } else {
        console.log("  No changes needed.");
    }

    // ── 5b. llm-gateway local D1 migrations ─────────────────────────────────────
    // The gateway's usage database is not created lazily: without its
    // migrations every request logs "no such table: usage_log". CI applies them
    // in test.yml; do the same here. Idempotent, local only.
    //
    // TWICE, because two gateways run in dev: the one inside the backend's
    // `lunora dev` session (the `SERVICE_LLM_GATEWAY` binding — it persists to
    // the backend's `.wrangler/state`) and the standalone one on :8787 that the
    // browser's `/v1/*` reaches (its own `.wrangler/state`).

    console.log("\nApplying llm-gateway local D1 migrations...");

    for (const [label, extra, hint] of [
        ["standalone :8787", [], ""],
        ["backend session", ["--persist-to", "../../backend/.wrangler/state"], " --persist-to ../../backend/.wrangler/state"],
    ]) {
        const migrate = spawnSync(
            "pnpm",
            ["--filter", "llm-gateway", "exec", "wrangler", "d1", "migrations", "apply", "llm-gateway-usage-dev", "--local", ...extra],
            {
                cwd: rootDir,
                encoding: "utf8",
                env: { ...process.env, CI: "1" },
            },
        );

        if (migrate.status === 0) {
            console.log(`  [ok]  llm-gateway-usage-dev (${label}) is up to date`);
        } else {
            console.log(`  [!!]  Could not apply them (${label}). Run:`);
            console.log(`        pnpm --filter llm-gateway exec wrangler d1 migrations apply llm-gateway-usage-dev --local${hint}`);
        }
    }

    // ── 5c. Rust toolchain for services/document-parser ────────────────────────
    // A Rust Worker: `lunora dev` runs its build (worker-build) on start, so a
    // machine without the toolchain cannot start the backend until it is
    // installed — unless `services/document-parser/build/` already exists.

    console.log("\nChecking the Rust toolchain (services/document-parser)...");

    const hasWasmTarget = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" }).stdout?.split("\n").includes("wasm32-unknown-unknown");
    const hasWorkerBuild = spawnSync("worker-build", ["--version"], { encoding: "utf8" }).status === 0;

    if (hasWasmTarget && hasWorkerBuild) {
        console.log("  [ok]  rustup target wasm32-unknown-unknown + worker-build");
    } else {
        console.log("  [!!]  Missing. Install Rust (https://rustup.rs), then:");
        console.log("        rustup target add wasm32-unknown-unknown");
        console.log("        cargo install worker-build --version 0.8.7 --locked");
    }

    // ── 6. Summary ─────────────────────────────────────────────────────────────

    console.log("\n=== Setup Summary ===\n");

    const coreKeys = ["BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "SITE_URL", "ADMIN", "ENVIRONMENT", "JWKS"];
    const aiKeys = ["OPENROUTER_API_KEY", "FAL_API_KEY", "GROQ_API_KEY", "REQUESTY_API_KEY", "XAI_API_KEY", "REPLICATE_API_TOKEN"];

    console.log("Backend core:");
    for (const key of coreKeys) {
        const status = backendEnv[key] ? "configured" : "MISSING";
        console.log(`  ${status === "configured" ? "[ok]" : "[!!]"} ${key}: ${status}`);
    }

    console.log("\nBackend → Services (service bindings, run by `lunora dev`):");
    for (const svc of services) {
        if (svc.name === "embeddings") continue;

        const secretOk = !svc.backendSecretKey || backendEnv[svc.backendSecretKey] === svc.resolvedSecret;

        console.log(`  ${secretOk ? "[ok]" : "[!!]"} ${svc.name}${svc.backendSecretKey ? ` (${svc.backendSecretKey} ${secretOk ? "in sync" : "DRIFT"})` : ""}`);
    }

    console.log("\nAI Providers:");
    const configuredAI = aiKeys.filter((k) => backendEnv[k]);

    if (configuredAI.length === 0) {
        console.log("  [!!] No AI providers configured — chat won't work");
    } else {
        for (const key of aiKeys) {
            if (backendEnv[key]) console.log(`  [ok] ${key}`);
        }
    }

    console.log("\nOptional services (dev stubs active when missing):");
    // `lunora dev` never delivers mail (`backend/lunora/email/mailer.ts`).
    console.log("  [stub] Email — captured to the studio's Mail tab");
    console.log(`  ${backendEnv["GOOGLE_CLIENT_ID"] ? "[ok]" : "[stub]"} Google OAuth — ${backendEnv["GOOGLE_CLIENT_ID"] ? "enabled" : "email+password only"}`);
    // Optional sign-in providers: each needs its id AND secret (`backend/lunora/auth.ts`).
    for (const [label, idKey, secretKey] of [
        ["GitHub sign-in", "AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_CLIENT_SECRET"],
        ["Microsoft sign-in", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
        ["OIDC single sign-on", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
    ]) {
        const on = Boolean(backendEnv[idKey] && backendEnv[secretKey] && (idKey !== "OIDC_CLIENT_ID" || backendEnv["OIDC_ISSUER"]));

        console.log(`  ${on ? "[ok]" : "[off]"} ${label} — ${on ? "enabled" : "not configured (optional)"}`);
    }
    console.log(`  ${backendEnv["R2_ENDPOINT"] ? "[ok]" : "[stub]"} R2 Storage — ${backendEnv["R2_ENDPOINT"] ? "configured" : "set R2_ENDPOINT"}`);

    console.log("\n=== Next Steps ===\n");
    console.log("1. If you haven't generated the backend types yet:");
    console.log("   pnpm --filter @neore/backend run codegen   # Generate lunora/_generated");
    console.log("   pnpm env:sync:auth       # Generate proper JWKS\n");
    console.log("2. Start the development stack (web on :5173, backend + its services on :8788, public gateway on :8787):");
    console.log("   pnpm dev\n");

    rl.close();
};

main().catch((error) => {
    console.error("Setup failed:", error);
    rl.close();
    process.exit(1);
});
