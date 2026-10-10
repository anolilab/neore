#!/usr/bin/env node
// Fills missing lingui translations with an LLM over any OpenAI-compatible
// chat-completions API (OpenRouter by default).
//
//   pnpm translate:auto                       # every non-source locale
//   pnpm translate:auto --locale fr,it --limit 20
//   pnpm translate:auto --dry-run             # report only, no network
//   flags: --batch-size (50), --concurrency (4 locales at once), --model, --force
//
// Env: TRANSLATE_API_KEY (falls back to OPENROUTER_API_KEY),
//      TRANSLATE_API_BASE_URL (default https://openrouter.ai/api/v1),
//      TRANSLATE_MODEL (default below; --model overrides).
//
// Only EMPTY msgstrs are filled unless --force. Every reply is validated
// (ICU syntax, placeholders, tags, select keys); a rejected item is retried
// once with the problems fed back, then skipped and logged. Run `lingui
// extract` first so the catalogs contain the current message set — this
// script translates what the catalogs hold and adds nothing to them.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import config from "../lingui.config.ts";
import { buildMessages, checkBatch, chunk, collectPending, parseModelReply, styleExamples } from "./i18n/batch.mjs";
import { parsePo, patchPo } from "./i18n/po.mjs";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 180_000;

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = (locale) => join(appRoot, "src", "locales", locale, "messages.po");

const { values: flags } = parseArgs({
    options: {
        "batch-size": { default: "50", type: "string" },
        concurrency: { default: "4", type: "string" },
        "dry-run": { default: false, type: "boolean" },
        force: { default: false, type: "boolean" },
        help: { default: false, short: "h", type: "boolean" },
        limit: { type: "string" },
        locale: { multiple: true, type: "string" },
        model: { type: "string" },
    },
});

if (flags.help) {
    console.log(`Usage: translate-catalogs [--locale de,fr] [--limit N] [--batch-size 50] [--concurrency 4] [--model id] [--force] [--dry-run]`);
    process.exit(0);
}

const positiveInt = (name, raw) => {
    const value = Number(raw);

    if (!Number.isInteger(value) || value < 1) {
        console.error(`--${name} must be a positive integer, got "${raw}"`);
        process.exit(2);
    }

    return value;
};

const batchSize = positiveInt("batch-size", flags["batch-size"]);
const concurrency = positiveInt("concurrency", flags.concurrency);
const limit = flags.limit === undefined ? Number.POSITIVE_INFINITY : positiveInt("limit", flags.limit);
const model = flags.model ?? process.env.TRANSLATE_MODEL ?? DEFAULT_MODEL;
const baseUrl = (process.env.TRANSLATE_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
const apiKey = process.env.TRANSLATE_API_KEY ?? process.env.OPENROUTER_API_KEY;

const targetLocales = config.locales.filter((locale) => locale !== config.sourceLocale);
const requested = flags.locale
    ?.flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
const unknown = requested?.filter((locale) => !targetLocales.includes(locale)) ?? [];

if (unknown.length > 0) {
    console.error(`Unknown or source locale(s): ${unknown.join(", ")}. Targets: ${targetLocales.join(", ")}`);
    process.exit(2);
}

if (!flags["dry-run"] && !apiKey) {
    console.error("Set TRANSLATE_API_KEY (or OPENROUTER_API_KEY), or pass --dry-run.");
    process.exit(2);
}

const complete = async (messages) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
        body: JSON.stringify({ messages, model, response_format: { type: "json_object" }, temperature: 0.2 }),
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            // OpenRouter attribution headers; ignored by other providers.
            "x-title": "Neore catalog translation",
        },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`);
    }

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;

    if (typeof content !== "string") {
        throw new TypeError(`unexpected response shape: ${JSON.stringify(payload).slice(0, 500)}`);
    }

    return parseModelReply(content);
};

// One request, retried once on a transport or JSON failure — a malformed reply
// is as likely to be transient as a 5xx.
const requestBatch = async (locale, batch, options) => {
    try {
        return await complete(buildMessages(locale, batch, options));
    } catch (error) {
        console.warn(`  [${locale}] request failed (${error.message}); retrying once`);

        return complete(buildMessages(locale, batch, options));
    }
};

const sourceEntries = parsePo(await readFile(catalogPath(config.sourceLocale), "utf8"));
const sourceText = new Map(sourceEntries.map((entry) => [entry.key, entry.msgstr || entry.msgid]));

let totalWritten = 0;
let totalFailed = 0;

const translateLocale = async (locale) => {
    const path = catalogPath(locale);
    const entries = parsePo(await readFile(path, "utf8"));
    const { pending, skipped } = collectPending(entries, sourceText, { force: flags.force, limit });

    for (const { key, reason } of skipped) {
        console.warn(`  [${locale}] skip ${JSON.stringify(key)}: ${reason}`);
    }

    console.log(`[${locale}] ${pending.length} to translate${flags.force ? " (--force)" : ""}`);

    if (flags["dry-run"] || pending.length === 0) {
        for (const item of pending.slice(0, 5)) {
            console.log(`  - ${JSON.stringify(item.source)}`);
        }

        return;
    }

    const examples = styleExamples(entries, sourceText);
    const batches = chunk(pending, batchSize);

    for (const [index, batch] of batches.entries()) {
        const label = `[${locale}] batch ${index + 1}/${batches.length}`;
        let accepted;
        let rejected;

        try {
            ({ accepted, rejected } = checkBatch(batch, await requestBatch(locale, batch, { examples })));

            if (rejected.size > 0) {
                const retry = batch.filter((item) => rejected.has(item.key));
                const second = checkBatch(retry, await requestBatch(locale, retry, { examples, feedback: rejected }));

                for (const [key, value] of second.accepted) {
                    accepted.set(key, value);
                }

                rejected = second.rejected;
            }
        } catch (error) {
            console.error(`  ${label} failed: ${error.message}`);
            totalFailed += batch.length;
            continue;
        }

        for (const [key, { problems, translation }] of rejected) {
            console.warn(`  ${label} rejected ${JSON.stringify(key)} → ${JSON.stringify(translation)}: ${problems.join("; ")}`);
        }

        // Write after every batch: a crash or rate limit keeps what is done,
        // and the next run resumes from the remaining empty msgstrs.
        if (accepted.size > 0) {
            await writeFile(path, patchPo(await readFile(path, "utf8"), accepted));
        }

        totalWritten += accepted.size;
        totalFailed += rejected.size;
        console.log(`  ${label}: ${accepted.size} written, ${rejected.size} rejected`);
    }
};

// Locales run in parallel — each owns its catalog file — batches within one
// locale run in order, so a locale's file is only ever written by one task.
const queue = [...(requested ?? targetLocales)];

await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
            await translateLocale(queue.shift());
        }
    }),
);

console.log(`Done: ${totalWritten} translations written, ${totalFailed} not translated.`);

// Partial failure still exits 0 so the successful translations reach a PR;
// nothing succeeding at all means a bad key, model or endpoint.
if (totalWritten === 0 && totalFailed > 0) {
    process.exitCode = 1;
}
