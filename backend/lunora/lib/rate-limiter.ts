import { LunoraError } from "lunorash/server";
import type { RateLimitConfig, RateLimitDb } from "lunorash/ratelimit";
import { createDbStore, RateLimiter } from "lunorash/ratelimit";

import { internal } from "../_generated/internal";
import type { ActionCtx as ActionContext, MutationCtx as MutationContext } from "../_generated/server";
import { getSessionNetworkSignals } from "../auth";
import type { SessionUser } from "../auth/functions";

/**
 * The earlier `Ratelimit.fixedWindow(rate, period)` / `.tokenBucket(...)` builders and
 * its time constants have no `@lunora/ratelimit` equivalent — Lunora takes a plain
 * `RateLimitConfig` object (`{ kind, rate, period, capacity? }`). Its `shards`
 * option is gone (`@lunora/ratelimit@alpha.91` throws on it): a limit now
 * enforces its full `rate` on one bucket, which is what these numbers always meant.
 *
 * Rather than rewrite 155 config entries into object literals, the builders are
 * reproduced here as one-liners. That keeps the table below reviewable as a table:
 * a diff against the original shows a limit changing, not a syntax change.
 */
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const Ratelimit = {
    fixedWindow: (rate: number, period: number): RateLimitConfig => {
        return {
            kind: "fixed window",
            period,
            rate,
        };
    },
    slidingWindow: (rate: number, period: number): RateLimitConfig => {
        return {
            kind: "sliding window",
            period,
            rate,
        };
    },
    tokenBucket: (rate: number, period: number, capacity?: number): RateLimitConfig => {
        return {
            capacity,
            kind: "token bucket",
            period,
            rate,
        };
    },
};

// Rate limit algorithm configs — keyed by rate limit name

/**
 * The rate-limit table.
 *
 * NOT annotated `Record<string, RateLimitConfig>`. That annotation collapsed
 * `RateLimitName` (below) to plain `string`, so EVERY `rateLimit("…")` call site
 * in the codebase was unchecked — a typo'd name compiled and fell through to
 * whatever `getRateLimitKey` produced, silently applying no limit. `satisfies`
 * keeps the same checking on the values while preserving the literal keys.
 */
export const RATE_LIMIT_CONFIGS = {
    // `POST /admin/seed-invitations`, per client IP and charged before the token
    // check — this is what throttles guessing `LUNORA_ADMIN_TOKEN`. Untiered: the
    // caller has no identity to derive a tier from.
    "admin/seedInvitations": Ratelimit.fixedWindow(5, 15 * MINUTE),

    // API usage limits
    "api/usage:free": Ratelimit.tokenBucket(100, MINUTE, 200),
    "api/usage:premium": Ratelimit.tokenBucket(200, MINUTE, 400),
    "api/usage:public": Ratelimit.tokenBucket(50, MINUTE, 100),

    // `auth/api-keys.ts#createScopedApiKey` — minting a public-API key.
    "apiKeys/create:free": Ratelimit.fixedWindow(10, HOUR),
    "apiKeys/create:premium": Ratelimit.fixedWindow(20, HOUR),

    // Auth limits
    "auth/failure:free": Ratelimit.fixedWindow(5, 15 * MINUTE),
    "auth/failure:premium": Ratelimit.fixedWindow(10, 15 * MINUTE),
    "auth/failure:public": Ratelimit.fixedWindow(3, 15 * MINUTE),

    // Billing limits
    // `billing/checkout.ts` — each call is an outbound Creem request.
    "billing/checkout:free": Ratelimit.fixedWindow(10, HOUR),
    "billing/checkout:premium": Ratelimit.fixedWindow(20, HOUR),
    "billing/update:free": Ratelimit.fixedWindow(5, MINUTE),
    "billing/update:premium": Ratelimit.fixedWindow(15, MINUTE),
    // Browser automation limits
    "browser/action:free": Ratelimit.fixedWindow(20, HOUR),

    "browser/action:premium": Ratelimit.fixedWindow(200, HOUR),
    "browser/action:public": Ratelimit.fixedWindow(5, HOUR),
    "byok/decrypt:free": Ratelimit.fixedWindow(100, MINUTE),

    "byok/decrypt:premium": Ratelimit.fixedWindow(300, MINUTE),
    // BYOK key operation limits
    "byok/save:free": Ratelimit.fixedWindow(10, 15 * MINUTE),
    "byok/save:premium": Ratelimit.fixedWindow(30, 15 * MINUTE),

    // Chat import limits
    "chat-import/start:free": Ratelimit.fixedWindow(5, HOUR),
    "chat-import/start:premium": Ratelimit.fixedWindow(20, HOUR),

    // Chat attachments taken into chat files (`file.ts#finalizeChatUpload`):
    // each is up to 25 MB hashed and re-stored. A burst covers dropping a
    // handful of files at once.
    "chat/attachmentUpload:free": Ratelimit.tokenBucket(20, MINUTE, 30),
    "chat/attachmentUpload:premium": Ratelimit.tokenBucket(60, MINUTE, 90),

    // Composer ghost text (`chat/autocomplete.ts`): one tiny utility-model call
    // per pause in typing — frequent by design, so generous, but bounded. Its
    // own family so typing never spends the optimizer's or translate's budget.
    "chat/autocomplete:free": Ratelimit.tokenBucket(30, MINUTE, 40),
    "chat/autocomplete:premium": Ratelimit.tokenBucket(60, MINUTE, 80),

    // Chat CRUD limits
    "chat/create:free": Ratelimit.fixedWindow(20, MINUTE),
    "chat/create:premium": Ratelimit.fixedWindow(60, MINUTE),

    // Daily content limits per user tier - AUDIO
    "chat/dailyAudio:anonymous": Ratelimit.fixedWindow(1, DAY),

    "chat/dailyAudio:free": Ratelimit.fixedWindow(5, DAY),
    "chat/dailyAudio:premium": Ratelimit.fixedWindow(100, DAY),
    // Daily content limits per user tier - IMAGE
    "chat/dailyImage:anonymous": Ratelimit.fixedWindow(1, DAY),

    "chat/dailyImage:free": Ratelimit.fixedWindow(5, DAY),
    "chat/dailyImage:premium": Ratelimit.fixedWindow(100, DAY),

    // Daily content limits per user tier - MUSIC
    // Music renders are cheaper than video (Stable Audio ~$0.20/render vs
    // video's $0.50–$1.50) so the free-tier ceiling is higher.
    "chat/dailyMusic:free": Ratelimit.fixedWindow(10, DAY),
    "chat/dailyMusic:premium": Ratelimit.fixedWindow(150, DAY),
    // Per-user/day URL retrieve cap. Each retrieved URL counts.
    // BYOK Firecrawl users get the higher tier so they're not throttled
    // beyond what their own paid quota would already absorb. The platform
    // (Exa + fallback Firecrawl env key) path is the one that genuinely
    // needs the cap — counts are deducted with `count: urls.length`.
    "chat/dailyRetrieve:anonymous": Ratelimit.fixedWindow(5, DAY),

    "chat/dailyRetrieve:free": Ratelimit.fixedWindow(50, DAY),
    "chat/dailyRetrieve:premium": Ratelimit.fixedWindow(500, DAY),
    // Daily content limits per user tier - TEXT
    "chat/dailyText:anonymous": Ratelimit.fixedWindow(10, DAY),

    "chat/dailyText:free": Ratelimit.fixedWindow(20, DAY),
    "chat/dailyText:premium": Ratelimit.fixedWindow(1000, DAY),

    // Daily content limits per user tier - VIDEO
    // Note: "chat/dailyVideo:anonymous" is intentionally omitted (limit=0 means always blocked)
    // The calling code already handles capacity===0 by returning early.
    "chat/dailyVideo:free": Ratelimit.fixedWindow(5, DAY),
    "chat/dailyVideo:premium": Ratelimit.fixedWindow(100, DAY),
    "chat/delete:free": Ratelimit.fixedWindow(10, MINUTE),
    "chat/delete:premium": Ratelimit.fixedWindow(30, MINUTE),

    // Follow-up suggestions: an LLM call per invocation. Its own family, so the
    // suggestions a client fetches after every reply cannot eat the budget of
    // real thread edits (`chat/update`), and vice versa.
    "chat/followups:free": Ratelimit.fixedWindow(30, MINUTE),
    "chat/followups:premium": Ratelimit.fixedWindow(100, MINUTE),
    "chat/globalPromptImprovement": Ratelimit.tokenBucket(1000, MINUTE, 1500),
    // Link preview cards (`chat/link-preview.ts`): charged only on a cache miss,
    // each one outbound fetch of at most 5s. A thread scrolled into view can ask
    // for several at once, hence the burst.
    "chat/linkPreview:free": Ratelimit.tokenBucket(30, MINUTE, 60),
    "chat/linkPreview:premium": Ratelimit.tokenBucket(90, MINUTE, 150),
    // Chat/AI limits (tiered)
    "chat/message:free": Ratelimit.tokenBucket(30, MINUTE, 50),
    "chat/message:premium": Ratelimit.tokenBucket(100, MINUTE, 200),
    "chat/message:public": Ratelimit.fixedWindow(10, HOUR),
    "chat/promptImprovement:free": Ratelimit.tokenBucket(10, MINUTE, 15),
    "chat/promptImprovement:premium": Ratelimit.tokenBucket(30, MINUTE, 50),
    "chat/promptImprovement:public": Ratelimit.fixedWindow(3, HOUR),
    "chat/stream:free": Ratelimit.tokenBucket(30, MINUTE, 50),

    "chat/stream:premium": Ratelimit.tokenBucket(100, MINUTE, 200),

    // "Translate" on a message: one short utility-model call per cache miss
    // (`chat/translate.ts`); its own family so it does not spend the optimizer's.
    // No `:public` tier: the action requires a session.
    "chat/translate:free": Ratelimit.tokenBucket(20, MINUTE, 30),
    "chat/translate:premium": Ratelimit.tokenBucket(60, MINUTE, 100),
    "chat/update:free": Ratelimit.fixedWindow(30, MINUTE),
    "chat/update:premium": Ratelimit.fixedWindow(100, MINUTE),

    // Coding-agent delegation (`coding-agents/`): each run is a sandbox for up to
    // 20 minutes on the user's own provider key, on top of one-at-a-time.
    "codingAgent/pr:free": Ratelimit.fixedWindow(10, HOUR),
    "codingAgent/pr:premium": Ratelimit.fixedWindow(30, HOUR),
    "codingAgent/run:free": Ratelimit.fixedWindow(5, HOUR),
    "codingAgent/run:premium": Ratelimit.fixedWindow(20, HOUR),

    // Connector OAuth: start/complete each make outbound discovery, registration
    // and token calls, and disconnect a revocation call.
    "connectors/oauth:free": Ratelimit.fixedWindow(20, MINUTE),
    "connectors/oauth:premium": Ratelimit.fixedWindow(40, MINUTE),
    // Device execution (`devices/`). Pairing is rare; a call is one approval
    // prompt on the user's own computer, so a looping model is cut off early.
    // Heartbeats come every 30 s per open shell window.
    "devices/call:free": Ratelimit.fixedWindow(60, MINUTE),
    "devices/call:premium": Ratelimit.fixedWindow(60, MINUTE),
    "devices/heartbeat:free": Ratelimit.fixedWindow(12, MINUTE),
    "devices/heartbeat:premium": Ratelimit.fixedWindow(12, MINUTE),
    "devices/manage:free": Ratelimit.fixedWindow(30, MINUTE),
    "devices/manage:premium": Ratelimit.fixedWindow(30, MINUTE),
    "devices/manifest:free": Ratelimit.fixedWindow(30, HOUR),
    "devices/manifest:premium": Ratelimit.fixedWindow(30, HOUR),
    "devices/register:free": Ratelimit.fixedWindow(5, HOUR),
    "devices/register:premium": Ratelimit.fixedWindow(5, HOUR),
    "devices/relay:free": Ratelimit.fixedWindow(120, MINUTE),
    "devices/relay:premium": Ratelimit.fixedWindow(120, MINUTE),
    // Evals (`evals/functions.ts`). `run` starts a whole dataset of headless agent
    // runs; each case is also charged to the daily chat and task limits
    // (`tasks/account.ts:chargeRound`), so this only paces the starts.
    "evals/create:free": Ratelimit.fixedWindow(20, MINUTE),
    "evals/create:premium": Ratelimit.fixedWindow(60, MINUTE),
    "evals/delete:free": Ratelimit.fixedWindow(20, MINUTE),
    "evals/delete:premium": Ratelimit.fixedWindow(60, MINUTE),
    "evals/run:free": Ratelimit.fixedWindow(3, MINUTE),
    "evals/run:premium": Ratelimit.fixedWindow(10, MINUTE),
    "evals/update:free": Ratelimit.fixedWindow(30, MINUTE),
    "evals/update:premium": Ratelimit.fixedWindow(90, MINUTE),
    // General rate limits
    free: Ratelimit.tokenBucket(40, 10 * SECOND, 40),
    // GDPR limits
    "gdpr/request:free": Ratelimit.fixedWindow(3, HOUR),

    "gdpr/request:premium": Ratelimit.fixedWindow(5, HOUR),
    // Adding a file to the knowledge base schedules its ingestion.
    "knowledge/add:free": Ratelimit.fixedWindow(20, MINUTE),
    "knowledge/add:premium": Ratelimit.fixedWindow(60, MINUTE),
    // `addDocuments` charges ONE token PER DOCUMENT here (a batch holds up to
    // 25), so a batch costs what its ingestions cost. The burst fits one full
    // batch; `knowledge/add` would refuse a batch outright.
    "knowledge/addDocument:free": Ratelimit.tokenBucket(30, MINUTE, 50),
    "knowledge/addDocument:premium": Ratelimit.tokenBucket(90, MINUTE, 150),
    // Removing a file or detaching it from a thread schedules no ingestion, and
    // must stay possible when the add budget is spent — cleaning up is how a
    // user gets back under it.
    "knowledge/remove:free": Ratelimit.fixedWindow(30, MINUTE),
    "knowledge/remove:premium": Ratelimit.fixedWindow(90, MINUTE),
    // Knowledge-base search over the public API; each call embeds the query.
    "knowledge/search:free": Ratelimit.fixedWindow(30, MINUTE),
    "knowledge/search:premium": Ratelimit.fixedWindow(120, MINUTE),
    // MCP App proxy (readResource / callTool) — guards user-supplied
    // MCP server URLs from being abused as a connection-pool DoS vector.
    "mcp/proxy:free": Ratelimit.tokenBucket(20, MINUTE, 30),

    "mcp/proxy:premium": Ratelimit.tokenBucket(60, MINUTE, 90),
    // MCP Registry browsing (settings page) — each uncached search is an
    // outbound registry call, so free text cannot be an unbounded fan-out.
    "mcp/registry:free": Ratelimit.tokenBucket(30, MINUTE, 40),

    "mcp/registry:premium": Ratelimit.tokenBucket(60, MINUTE, 90),
    // Memory management (edit / pin / retype / delete / dismiss a digest)
    "memory/update:free": Ratelimit.fixedWindow(60, MINUTE),
    "memory/update:premium": Ratelimit.fixedWindow(180, MINUTE),
    // Messenger connection limits
    "messenger/connect:free": Ratelimit.fixedWindow(5, MINUTE),
    "messenger/connect:premium": Ratelimit.fixedWindow(15, MINUTE),
    // Whole-connection inbound cap, on top of the per-sender one below: a group
    // chat or a bot open to many senders shares one owner's key and one budget.
    "messenger/connection:free": Ratelimit.fixedWindow(60, HOUR),
    "messenger/connection:premium": Ratelimit.fixedWindow(300, HOUR),
    "messenger/disconnect:free": Ratelimit.fixedWindow(10, MINUTE),
    "messenger/disconnect:premium": Ratelimit.fixedWindow(30, MINUTE),
    // Per-platform-sender inbound message cap. Bot owner pays the LLM bill,
    // so the cap is keyed on (connectionId, platformUserId) to prevent a
    // single sender (e.g. anyone with DM access to a public Telegram bot)
    // from running up arbitrary LLM cost on the owner's BYOK key.
    "messenger/inbound:free": Ratelimit.fixedWindow(20, HOUR),
    "messenger/inbound:premium": Ratelimit.fixedWindow(120, HOUR),
    "messenger/inbound:public": Ratelimit.fixedWindow(20, HOUR),
    // Pairing: `/pair <code>` guesses per sender on a connection, and per
    // connection across senders (the code is ~40 bits and lives 15 minutes) —
    // the higher connection cap is what a stranger with many accounts can spend,
    // one stranger alone cannot lock the owner out. And the "this bot is
    // private" reply per stranger, so a stranger cannot make the bot spam or
    // spend the owner's platform quota.
    "messenger/pairAttempt": Ratelimit.fixedWindow(5, 15 * MINUTE),
    "messenger/pairAttemptConnection": Ratelimit.fixedWindow(30, 15 * MINUTE),
    "messenger/privateNotice": Ratelimit.fixedWindow(1, HOUR),
    // Notifications (`notifications/`): read state and the Daily Brief toggle,
    // and push subscribe/unsubscribe (each a browser permission prompt at most).
    "notifications/push:free": Ratelimit.fixedWindow(10, MINUTE),
    "notifications/push:premium": Ratelimit.fixedWindow(30, MINUTE),
    "notifications/update:free": Ratelimit.fixedWindow(60, MINUTE),
    "notifications/update:premium": Ratelimit.fixedWindow(180, MINUTE),
    "organization/cancelInvite:free": Ratelimit.fixedWindow(10, MINUTE),
    "organization/cancelInvite:premium": Ratelimit.fixedWindow(30, MINUTE),
    // Organization limits
    "organization/create:free": Ratelimit.fixedWindow(3, HOUR),
    "organization/create:premium": Ratelimit.fixedWindow(10, HOUR),
    "organization/invite:free": Ratelimit.fixedWindow(5, MINUTE),
    "organization/invite:premium": Ratelimit.fixedWindow(20, MINUTE),
    "organization/leave:free": Ratelimit.fixedWindow(3, MINUTE),
    "organization/leave:premium": Ratelimit.fixedWindow(10, MINUTE),

    "organization/rejectInvite:free": Ratelimit.fixedWindow(10, MINUTE),

    "organization/rejectInvite:premium": Ratelimit.fixedWindow(30, MINUTE),
    "organization/removeMember:free": Ratelimit.fixedWindow(5, MINUTE),
    "organization/removeMember:premium": Ratelimit.fixedWindow(15, MINUTE),
    "organization/setActive:free": Ratelimit.fixedWindow(10, MINUTE),
    "organization/setActive:premium": Ratelimit.fixedWindow(30, MINUTE),
    "organization/update:free": Ratelimit.fixedWindow(10, MINUTE),

    "organization/update:premium": Ratelimit.fixedWindow(30, MINUTE),
    "organization/updateRole:free": Ratelimit.fixedWindow(5, MINUTE),
    "organization/updateRole:premium": Ratelimit.fixedWindow(15, MINUTE),
    // Pages workspace (`pages/`). `save` is the editor's autosave (1.5 s
    // debounce), so it is sized for continuous typing; `agent` is an LLM call.
    "pages/agent:free": Ratelimit.tokenBucket(10, MINUTE, 20),
    "pages/agent:premium": Ratelimit.tokenBucket(30, MINUTE, 60),
    "pages/comment:free": Ratelimit.fixedWindow(30, MINUTE),
    "pages/comment:premium": Ratelimit.fixedWindow(100, MINUTE),
    "pages/create:free": Ratelimit.fixedWindow(20, MINUTE),
    "pages/create:premium": Ratelimit.fixedWindow(60, MINUTE),
    "pages/delete:free": Ratelimit.fixedWindow(20, MINUTE),
    "pages/delete:premium": Ratelimit.fixedWindow(60, MINUTE),
    "pages/presence:free": Ratelimit.fixedWindow(30, MINUTE),
    "pages/presence:premium": Ratelimit.fixedWindow(60, MINUTE),
    "pages/save:free": Ratelimit.fixedWindow(90, MINUTE),
    "pages/save:premium": Ratelimit.fixedWindow(240, MINUTE),
    "pages/share:free": Ratelimit.fixedWindow(10, MINUTE),
    "pages/share:premium": Ratelimit.fixedWindow(30, MINUTE),
    "pages/update:free": Ratelimit.fixedWindow(60, MINUTE),
    "pages/update:premium": Ratelimit.fixedWindow(180, MINUTE),
    // Pins limits
    "pins/create:free": Ratelimit.fixedWindow(20, MINUTE),
    "pins/create:premium": Ratelimit.fixedWindow(60, MINUTE),
    "pins/delete:free": Ratelimit.fixedWindow(20, MINUTE),

    "pins/delete:premium": Ratelimit.fixedWindow(60, MINUTE),
    "pins/update:free": Ratelimit.fixedWindow(30, MINUTE),
    "pins/update:premium": Ratelimit.fixedWindow(100, MINUTE),
    premium: Ratelimit.tokenBucket(100, 10 * SECOND, 100),
    // Project limits
    "project/create:free": Ratelimit.fixedWindow(5, MINUTE),
    "project/create:premium": Ratelimit.fixedWindow(20, MINUTE),
    "project/member:free": Ratelimit.fixedWindow(10, MINUTE),
    "project/member:premium": Ratelimit.fixedWindow(30, MINUTE),

    "project/update:free": Ratelimit.fixedWindow(20, MINUTE),
    "project/update:premium": Ratelimit.fixedWindow(60, MINUTE),

    // Projects (plural) aliases used by projects/functions.ts
    "projects/create:free": Ratelimit.fixedWindow(5, MINUTE),
    "projects/create:premium": Ratelimit.fixedWindow(20, MINUTE),
    "projects/delete:free": Ratelimit.fixedWindow(5, MINUTE),
    "projects/delete:premium": Ratelimit.fixedWindow(15, MINUTE),
    "projects/update:free": Ratelimit.fixedWindow(20, MINUTE),
    "projects/update:premium": Ratelimit.fixedWindow(60, MINUTE),

    // Prompts limits
    "prompts/create:free": Ratelimit.fixedWindow(10, MINUTE),

    "prompts/create:premium": Ratelimit.fixedWindow(30, MINUTE),

    "prompts/delete:free": Ratelimit.fixedWindow(10, MINUTE),
    "prompts/delete:premium": Ratelimit.fixedWindow(30, MINUTE),
    "prompts/update:free": Ratelimit.fixedWindow(20, MINUTE),
    "prompts/update:premium": Ratelimit.fixedWindow(60, MINUTE),

    public: Ratelimit.tokenBucket(20, 10 * SECOND, 20),
    // Public v1 API (`public-api/router.ts`): PER-KEY limits (identifier = the
    // key id), applied before any procedure runs; the procedure's own per-user
    // limits still apply on top. Only `:free` is read — `:premium` exists so the
    // base resolves for every tier like the rest.
    "publicApi/read:free": Ratelimit.tokenBucket(120, MINUTE, 240),
    "publicApi/read:premium": Ratelimit.tokenBucket(120, MINUTE, 240),
    "publicApi/write:free": Ratelimit.tokenBucket(30, MINUTE, 60),
    "publicApi/write:premium": Ratelimit.tokenBucket(30, MINUTE, 60),
    // Sandbox / code execution limits
    "sandbox/execute:free": Ratelimit.fixedWindow(30, HOUR),
    "sandbox/execute:premium": Ratelimit.fixedWindow(200, HOUR),
    "sandbox/execute:public": Ratelimit.fixedWindow(5, HOUR),
    // Scraper limits (admin only)
    scraper: Ratelimit.fixedWindow(10, MINUTE),
    // Sharing limits
    "sharing/create:free": Ratelimit.fixedWindow(5, MINUTE),

    "sharing/create:premium": Ratelimit.fixedWindow(15, MINUTE),
    "sharing/update:free": Ratelimit.fixedWindow(10, MINUTE),
    "sharing/update:premium": Ratelimit.fixedWindow(30, MINUTE),
    // Skills limits — mirror the prompts CRUD shape; `invoke` is closer to a chat
    // action, so it gets a token bucket rather than a fixed window.
    //
    // These were MISSING. `rateLimit("skills/create")` resolves to
    // `"skills/create:free"`, which `createRatelimit` looks up and then
    // `throw new LunoraError("BAD_REQUEST", "Unknown rate limit config: …")`. So every skills
    // create/update/delete/invoke THREW at runtime. It compiled only because
    // RATE_LIMIT_CONFIGS was annotated `Record<string, RateLimitConfig>`, which
    // collapsed `RateLimitName` to plain `string`.
    // Agent Builder: every clarify/draft/refine turn is an LLM call, and a
    // conversation takes several — its own budget, so building one agent does
    // not starve the prompt optimizer's `chat/promptImprovement`.
    "skills/builder:free": Ratelimit.tokenBucket(10, MINUTE, 20),
    "skills/builder:premium": Ratelimit.tokenBucket(30, MINUTE, 60),
    "skills/create:free": Ratelimit.fixedWindow(10, MINUTE),
    "skills/create:premium": Ratelimit.fixedWindow(30, MINUTE),
    "skills/delete:free": Ratelimit.fixedWindow(10, MINUTE),
    "skills/delete:premium": Ratelimit.fixedWindow(30, MINUTE),
    "skills/invoke:free": Ratelimit.tokenBucket(30, MINUTE, 50),
    "skills/invoke:premium": Ratelimit.tokenBucket(100, MINUTE, 200),
    "skills/update:free": Ratelimit.fixedWindow(20, MINUTE),
    "skills/update:premium": Ratelimit.fixedWindow(60, MINUTE),
    // Sub-agent starts (`sub-agents/functions.ts`), on top of the task quotas
    // each start is charged (`tasks/account.ts:chargeRound`) and the fan-out cap.
    "subAgents/run:free": Ratelimit.fixedWindow(10, HOUR),
    "subAgents/run:premium": Ratelimit.fixedWindow(60, HOUR),
    // Tag limits
    "tag/create:free": Ratelimit.fixedWindow(10, MINUTE),
    "tag/create:premium": Ratelimit.fixedWindow(30, MINUTE),
    "tag/delete:free": Ratelimit.fixedWindow(10, MINUTE),
    "tag/delete:premium": Ratelimit.fixedWindow(30, MINUTE),
    "tag/update:free": Ratelimit.fixedWindow(20, MINUTE),
    "tag/update:premium": Ratelimit.fixedWindow(60, MINUTE),
    // Tasks and goals (`tasks/functions.ts`). `run` also covers review decisions:
    // each one can start a full headless agent run plus a verifier call.
    "tasks/create:free": Ratelimit.fixedWindow(10, MINUTE),

    "tasks/create:premium": Ratelimit.fixedWindow(30, MINUTE),
    // Rounds per day, on top of `chat/dailyText` (`tasks/account.ts:chargeRound`):
    // a recurring task must not spend a user's whole message allowance.
    "tasks/dailyRuns:free": Ratelimit.fixedWindow(10, DAY),
    "tasks/dailyRuns:premium": Ratelimit.fixedWindow(200, DAY),
    "tasks/delete:free": Ratelimit.fixedWindow(10, MINUTE),
    "tasks/delete:premium": Ratelimit.fixedWindow(30, MINUTE),
    "tasks/run:free": Ratelimit.fixedWindow(5, MINUTE),
    "tasks/run:premium": Ratelimit.fixedWindow(20, MINUTE),
    "tasks/update:free": Ratelimit.fixedWindow(20, MINUTE),

    "tasks/update:premium": Ratelimit.fixedWindow(60, MINUTE),
    // Team limits
    "team/addMember:free": Ratelimit.fixedWindow(10, MINUTE),
    "team/addMember:premium": Ratelimit.fixedWindow(30, MINUTE),
    "team/create:free": Ratelimit.fixedWindow(5, MINUTE),

    "team/create:premium": Ratelimit.fixedWindow(15, MINUTE),

    "team/delete:free": Ratelimit.fixedWindow(5, MINUTE),
    "team/delete:premium": Ratelimit.fixedWindow(15, MINUTE),
    "team/leave:free": Ratelimit.fixedWindow(5, MINUTE),
    "team/leave:premium": Ratelimit.fixedWindow(15, MINUTE),
    "team/removeMember:free": Ratelimit.fixedWindow(10, MINUTE),
    "team/removeMember:premium": Ratelimit.fixedWindow(30, MINUTE),

    "team/setActive:free": Ratelimit.fixedWindow(10, MINUTE),
    "team/setActive:premium": Ratelimit.fixedWindow(30, MINUTE),
    "team/update:free": Ratelimit.fixedWindow(10, MINUTE),
    "team/update:premium": Ratelimit.fixedWindow(30, MINUTE),
    "team/updateRole:free": Ratelimit.fixedWindow(5, MINUTE),
    "team/updateRole:premium": Ratelimit.fixedWindow(15, MINUTE),
    "team/updateSettings:free": Ratelimit.fixedWindow(10, MINUTE),
    "team/updateSettings:premium": Ratelimit.fixedWindow(30, MINUTE),

    // Trigger limits
    "triggers/create:free": Ratelimit.fixedWindow(5, MINUTE),

    "triggers/create:premium": Ratelimit.fixedWindow(20, MINUTE),
    "triggers/delete:free": Ratelimit.fixedWindow(5, MINUTE),
    "triggers/delete:premium": Ratelimit.fixedWindow(15, MINUTE),

    "triggers/update:free": Ratelimit.fixedWindow(10, MINUTE),
    "triggers/update:premium": Ratelimit.fixedWindow(30, MINUTE),
    // Inbound webhook deliveries per trigger (unauthenticated until the HMAC check).
    "triggers/webhook": Ratelimit.fixedWindow(60, MINUTE),
    // Uploads started on the upload route (`lib/upload-route.ts`), whatever
    // they are for: each may carry up to 25 MB, so the bucket bounds the bytes
    // a caller can push. Untiered — the route knows the caller's id, not their
    // plan; the per-plan limits sit on the finalize procedures.
    "uploads/create": Ratelimit.tokenBucket(60, MINUTE, 90),
    // Vault limits
    "vault/delete:free": Ratelimit.fixedWindow(10, MINUTE),

    "vault/delete:premium": Ratelimit.fixedWindow(30, MINUTE),
    "vault/upload:free": Ratelimit.fixedWindow(10, MINUTE),
    "vault/upload:premium": Ratelimit.fixedWindow(30, MINUTE),
    vercel: Ratelimit.tokenBucket(3, 10 * SECOND, 3),
    // Voice-mode speech (`voice/speech.ts`): the characters synthesised per
    // day, charged with `count` = the text's length — the enforced allowance
    // under the per-character credit cost.
    "voice/dailySpeechChars:free": Ratelimit.fixedWindow(10_000, DAY),
    "voice/dailySpeechChars:premium": Ratelimit.fixedWindow(200_000, DAY),
    // Realtime dictation — each token is one billed ElevenLabs Scribe session,
    // minted per mic press. Anonymous is refused outright (`voice/functions.ts`).
    "voice/scribeToken:free": Ratelimit.fixedWindow(30, HOUR),
    "voice/scribeToken:premium": Ratelimit.fixedWindow(120, HOUR),
    // Voice-mode speech calls: one per sentence group of a reply, so the burst
    // is a reply's worth. Guests are refused outright (`voice/speech.ts`).
    "voice/speech:free": Ratelimit.tokenBucket(30, MINUTE, 40),
    "voice/speech:premium": Ratelimit.tokenBucket(90, MINUTE, 120),
    // Workflow execution — same story as the skills entries above: the name was
    // used but never defined, so every `executeWorkflow` call threw. A run can fan
    // out into many model calls, so this is deliberately tighter than CRUD.
    "workflow/execute:free": Ratelimit.fixedWindow(5, MINUTE),
    "workflow/execute:premium": Ratelimit.fixedWindow(20, MINUTE),
    // Settings are written on every toggle and autosave; a loop of them is abuse, not use.
    "settings/update:free": Ratelimit.fixedWindow(60, MINUTE),
    "settings/update:premium": Ratelimit.fixedWindow(180, MINUTE),
    "organization/accept:free": Ratelimit.fixedWindow(10, MINUTE),
    "organization/accept:premium": Ratelimit.fixedWindow(30, MINUTE),
    "organization/delete:free": Ratelimit.fixedWindow(3, HOUR),
    "organization/delete:premium": Ratelimit.fixedWindow(10, HOUR),
    // A backfill walks the whole history, so it is rare by design.
    "usage/backfill:free": Ratelimit.fixedWindow(2, HOUR),
    "usage/backfill:premium": Ratelimit.fixedWindow(5, HOUR),
    "vault/download:free": Ratelimit.fixedWindow(30, MINUTE),
    "vault/download:premium": Ratelimit.fixedWindow(90, MINUTE),
    // Presence heartbeats run every few seconds per open editor.
    "workflow/presence:free": Ratelimit.fixedWindow(60, MINUTE),
    "workflow/presence:premium": Ratelimit.fixedWindow(180, MINUTE),
    "workflow/save:free": Ratelimit.fixedWindow(60, MINUTE),
    "workflow/save:premium": Ratelimit.fixedWindow(180, MINUTE),

    // Admin writes (roles, bans, sessions, impersonation log, invitations, gateway
    // keys). Admins always resolve to the premium tier; the free entry exists so
    // the base resolves for every tier like the rest.
    "admin/write:free": Ratelimit.fixedWindow(10, MINUTE),
    "admin/write:premium": Ratelimit.fixedWindow(30, MINUTE),
    // Admin reads: dashboards and lists.
    "admin/read:free": Ratelimit.fixedWindow(60, MINUTE),
    "admin/read:premium": Ratelimit.fixedWindow(120, MINUTE),
    // Admin cleanup: a bulk delete over every eligible account.
    "admin/cleanup:free": Ratelimit.fixedWindow(5, HOUR),
    "admin/cleanup:premium": Ratelimit.fixedWindow(10, HOUR),
    // Reads of the signed-in user's own library and usage (prompts, skills,
    // usage, notification rules). Panels and pickers re-read these often.
    "library/read:free": Ratelimit.fixedWindow(120, MINUTE),
    "library/read:premium": Ratelimit.fixedWindow(300, MINUTE),
    // Public share views (`getPublicThread`, `getPublicPage`, `getPublicWorkflow`),
    // bucketed by the share token (`rateLimit`'s `keyBy`), so one link's traffic
    // never throttles another link. It is a FLOOD bound on the whole link, shared
    // by all its readers, not a per-visitor quota: a popular link must stay open.
    // Guessing tokens gets no help from this; the token's length is the defence.
    // The free and premium entries are only read by a signed-in viewer's call.
    "share/view:public": Ratelimit.fixedWindow(600, MINUTE),
    "share/view:free": Ratelimit.fixedWindow(600, MINUTE),
    "share/view:premium": Ratelimit.fixedWindow(600, MINUTE),
    // `getChangelogs` is an anonymous read of a cached list. Actions carry no client
    // IP, so this is ONE bucket shared by every anonymous visitor: generous, to bound
    // abuse without throttling a busy landing page.
    "changelog/read:public": Ratelimit.fixedWindow(600, MINUTE),
    "changelog/read:free": Ratelimit.fixedWindow(600, MINUTE),
    "changelog/read:premium": Ratelimit.fixedWindow(600, MINUTE),
    "documents/update:free": Ratelimit.fixedWindow(60, MINUTE),
    "documents/update:premium": Ratelimit.fixedWindow(180, MINUTE),
} satisfies Record<string, RateLimitConfig>;

/**
 * A limit's BASE name — what call sites pass.
 *
 * Config keys are tier-suffixed (`"vault/upload:free"`), while `rateLimit()`
 * takes the base (`"vault/upload"`) and `getRateLimitKey` appends the tier. So
 * the union is the key set with the suffix stripped, not the key set itself.
 */
type StripTier<Key> = Key extends `${infer Base}:${string}` ? Base : Key;

export type RateLimitName = StripTier<keyof typeof RATE_LIMIT_CONFIGS>;

/**
 * A RESOLVED limit key — tier suffix already applied, ready to look up.
 *
 * The distinction from `RateLimitName` is the whole reason the casts existed.
 * There are two entry points and they take opposite ends of the same string:
 *
 * - `rateLimit(name)` / `rateLimitGuard` take the BASE and call
 *   `getRateLimitKey` to append the tier themselves.
 * - `checkRateLimit(ctx, key)` takes the key ALREADY resolved, because its
 *   callers compute the tier from something the middleware cannot see (a tool's
 *   `ctx.userTier`, a messenger connection's owner plan).
 *
 * `checkRateLimit` was typed `RateLimitName`, so all seven of the second kind
 * had to write `as any` to pass the resolved key they correctly held — which
 * also switched off checking of the key itself.
 */
export type RateLimitKey = keyof typeof RATE_LIMIT_CONFIGS;

/**
 * A limiter for one named config, over a Lunora table.
 *
 * The earlier `Ratelimit` was constructed per limit name and exposed
 * `limit(identifier)` / `resetUsedTokens(identifier)`. Lunora's `RateLimiter` is
 * constructed once per app with a config MAP and takes the name per call. The
 * facade below keeps the old call shape so the ~10 call sites are unchanged.
 *
 * `failureMode` is not a Lunora concept: its `limit()` propagates store errors.
 * "open" (allow on failure) is reproduced by catching and returning `ok`. The
 * default stays "closed", matching the earlier behaviour — an unavailable store must not silently
 * disable a limit that gates billing.
 */

/**
 * `db` is `RateLimitDb`, which demands `insert` / `patch` / `delete` — so a QUERY
 * context's reader does not satisfy it, even for `getRemaining`, which only reads.
 * Callers on the read path cast. `@lunora/ratelimit` now also exports
 * `createReadOnlyDbStore`, which would type the read path properly — not adopted
 * yet, so the cast is still what holds this together.
 */
export const createRatelimit = (
    name: string,
    database: RateLimitDb,
    failureMode: "open" | "closed" = "closed",
    /**
     * The clock the window is evaluated against. A read-only caller that runs in a
     * query passes the `now` it received as an argument, so a live re-run cannot
     * project the window to a different time. Omitted, the limiter reads `Date.now()`.
     */
    clock?: () => number,
) => {
    // Indexed by a runtime-built `<base>:<tier>` string, so the lookup is widened
    // rather than the table. The `if (!config)` below is the real check — and it
    // now has teeth, because a name that is not in the table genuinely reaches it.
    const config = (RATE_LIMIT_CONFIGS as Record<string, RateLimitConfig>)[name];

    if (!config) {
        throw new LunoraError("BAD_REQUEST", `Unknown rate limit config: ${name}`);
    }

    const limiter = new RateLimiter({
        config: { [name]: config },
        store: createDbStore({ db: database }),
        ...(clock && { now: clock }),
    });

    return {
        /**
         * Remaining units and the window's reset time, without consuming.
         *
         * The earlier `getRemaining` returned `{ remaining, reset }`. Lunora's
         * `getValue` returns the value projected forward to the current clock plus
         * the resolved config, which is the same information — `reset` is derived
         * from the stored timestamp and the config's period.
         */
        getRemaining: async (identifier: string) => {
            // `innerConfig` was renamed `config` in @lunora/ratelimit alpha.22.
            const { config: remainingConfig, ts, value } = await limiter.getValue(name, { key: `neore:${name}:${identifier}` });

            return { remaining: Math.max(0, value), reset: ts + remainingConfig.period };
        },
        limit: async (identifier: string, args?: { count?: number }) => {
            try {
                const status = await limiter.limit(name, { count: args?.count, key: `neore:${name}:${identifier}` });

                // The earlier implementation reported an absolute `reset` timestamp; Lunora reports a
                // relative `retryAfter`. Callers want the timestamp, so convert.
                return { ok: status.ok, reset: Date.now() + status.retryAfter, retryAfter: status.retryAfter };
            } catch (error) {
                if (failureMode === "open") {
                    return { ok: true, reset: Date.now(), retryAfter: 0 };
                }

                throw error;
            }
        },

        resetUsedTokens: async (identifier: string) => {
            await limiter.reset(name, { key: `neore:${name}:${identifier}` });
        },
    };
};

/**
 * Get rate limit key based on user tier.
 * Appends the tier suffix to the base key for tiered rate limits.
 * Returns the base key unchanged for general limits (free, premium, public, scraper, vercel).
 */
export const getRateLimitKey = (baseKey: RateLimitName, tier: "free" | "premium" | "public"): RateLimitKey => {
    if (["free", "premium", "public", "scraper", "vercel"].includes(baseKey)) {
        return baseKey as RateLimitKey;
    }

    // The one cast the types cannot discharge: TypeScript cannot prove a
    // runtime-built `${base}:${tier}` is in the table, and narrowing it
    // generically makes an ABSENT combination yield `never` — which is
    // assignable to everything and so reports nothing. The property "every tier
    // a caller can produce exists for every base a caller names" is enforced by
    // `rateLimiter.test.ts` instead, where a miss is a failing assertion rather
    // than an unhandled error in production.
    return `${baseKey}:${tier}` as RateLimitKey;
};

/**
 * Get user tier based on session user properties.
 */
export const getUserTier = (user: { isAdmin?: boolean; plan?: SessionUser["plan"] } | null): "free" | "premium" | "public" => {
    if (!user) {
        return "public";
    }

    if (user.isAdmin) {
        return "premium";
    }

    if (user.plan) {
        return "premium";
    }

    return "free";
};

/**
 * Guard function to check and enforce rate limits for mutations and actions.
 * For mutation contexts, uses ctx.db directly.
 * For action contexts, delegates to an internal mutation via ctx.runMutation.
 */
export const rateLimitGuard = async (
    context: {
        /** Tokens to take at once — one per unit of work the call starts. Default 1. */
        count?: number;
        // `RateLimitName`, not `string`: this is the BASE name, and typing it
        // loosely is what let `rateLimit("skills/create")` reach production
        // naming a limit that was never in the table.
        rateLimitKey: RateLimitName;
        /** Bucket to count against, when the caller is not the bucket (see `rateLimit`'s `keyBy`). */
        identifier?: string;
        user: Pick<SessionUser, "userId" | "plan"> | null;
    } & (ActionContext | MutationContext),
): Promise<void> => {
    const count = Math.max(1, Math.trunc(context.count ?? 1));
    const tier = getUserTier(context.user);
    const limitKey = getRateLimitKey(context.rateLimitKey, tier);

    let identifier: string;

    if (context.identifier !== undefined) {
        identifier = context.identifier;
    } else if (context.user?.userId) {
        identifier = context.user.userId;
    } else if ("db" in context) {
        // Mutation context: use IP for anonymous users to prevent shared bucket abuse
        const signals = await getSessionNetworkSignals(context as MutationContext).catch(() => {
            return {};
        });

        identifier = (signals as { ip?: string }).ip ?? "anonymous";
    } else {
        // An action has no session and no `db`. On Cloudflare `ip` is the edge-stamped
        // client address; elsewhere it is undefined and the one shared bucket applies.
        identifier = (context as { ip?: string }).ip ?? "anonymous";
    }

    if ("db" in context) {
        // Mutation/query context — use db directly
        const limiter = createRatelimit(limitKey, (context as MutationContext).db);
        const result = await limiter.limit(identifier, { count });

        if (!result.ok) {
            throw new LunoraError("TOO_MANY_REQUESTS", "Rate limit exceeded. Please try again later.", {
                data: {
                    code: "TOO_MANY_REQUESTS",
                    message: "Rate limit exceeded. Please try again later.",
                    retryAfter: Math.max(0, result.reset - Date.now()),
                },
            });
        }
    } else {
        // Action context — delegate to internal mutation
        const actionContext = context as unknown as ActionContext;
        const result = await actionContext.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
            count,
            identifier,
            key: limitKey,
        });

        if (!result.ok) {
            throw new LunoraError("TOO_MANY_REQUESTS", "Rate limit exceeded. Please try again later.", {
                data: { code: "TOO_MANY_REQUESTS", message: "Rate limit exceeded. Please try again later.", retryAfter: result.retryAfter },
            });
        }
    }
};

export interface RateLimitResponse {
    ok: boolean;
    remaining?: number;
    resetTime?: number;
    retryAfter?: number;
}

/**
 * The two context shapes this accepts, as a union rather than `any`.
 *
 * Deliberately structural and minimal: the callers are a mutation context, an
 * `ActionCtx`, an `HttpActionCtx` (which has no `db`) and the agent's tool
 * context, and no nominal type covers all four. Naming only what the body
 * actually reaches for lets all of them pass without a cast, while still making
 * `"db" in context` a real narrowing rather than a property probe on `any`.
 *
 * `runMutation` is optional because `ToolCtx` declares it `Runnable | undefined`
 * — a tool context genuinely might not carry it. Demanding it here rejected all
 * four tool call sites. Presence is therefore checked at runtime, right before
 * the call; this type's job is only to keep a context with NEITHER `db` nor
 * `runMutation` from type-checking its way to that throw.
 */
export type RateLimitContext = { db: RateLimitDb } | { runMutation?: ActionContext["runMutation"] };

/**
 * Check rate limit for a given operation (consumes a token).
 * For mutation/query contexts, uses ctx.db directly.
 * For action contexts, delegates to an internal mutation.
 */
export const checkRateLimit = async (
    context: RateLimitContext,
    operation: RateLimitKey,
    options: {
        count?: number;
        key?: string;
        throws?: boolean;
    } = {},
): Promise<RateLimitResponse> => {
    const identifier = options.key ?? "global";
    const count = options.count ?? 1;

    try {
        if ("db" in context) {
            // Mutation/query context — use db directly
            const limiter = createRatelimit(operation, context.db, options.throws ? "closed" : "open");
            const result = await limiter.limit(identifier, { count });

            if (!result.ok && options.throws) {
                throw new LunoraError("TOO_MANY_REQUESTS", "Rate limit exceeded. Please try again later.", {
                    data: {
                        code: "TOO_MANY_REQUESTS",
                        message: "Rate limit exceeded. Please try again later.",
                        retryAfter: Math.max(0, result.reset - Date.now()),
                    },
                });
            }

            // No `remaining`. Lunora's `limit()` returns `{ ok, reset, retryAfter }`
            // — the count is not part of the consume result, and reading it means a
            // second round trip through `getValue`. `remaining` is optional on
            // `RateLimitResponse` for exactly this reason; callers that want the
            // number ask `getRemaining()` directly rather than paying for it on
            // every limited call.
            return {
                ok: result.ok,
                resetTime: result.reset,
                retryAfter: result.ok ? undefined : Math.max(0, result.reset - Date.now()),
            };
        }

        // Action context — delegate to internal mutation.
        if (!context.runMutation) {
            throw new Error("checkRateLimit needs a context with `db` or `runMutation`, and this one has neither");
        }

        const result = await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
            count,
            identifier,
            key: operation,
        });

        if (!result.ok && options.throws) {
            throw new LunoraError("TOO_MANY_REQUESTS", "Rate limit exceeded. Please try again later.", {
                data: { code: "TOO_MANY_REQUESTS", message: "Rate limit exceeded. Please try again later.", retryAfter: result.retryAfter },
            });
        }

        return {
            ok: result.ok,
            retryAfter: result.retryAfter,
        };
    } catch (error: any) {
        // Scoped to the code, not to `instanceof LunoraError`. Only the rate-limit
        // error this function throws itself is meant to propagate; anything else
        // (a failed internal mutation, an infra error) still fails OPEN below, as
        // it did when this checked the earlier error class. Widening it to any
        // LunoraError would turn those into request rejections.
        if (error instanceof LunoraError && error.code === "TOO_MANY_REQUESTS") {
            throw error;
        }

        return { ok: false };
    }
};

/**
 * Reset rate limit for a given operation and optional key.
 */
export const resetRateLimit = async (context: any, operation: RateLimitName, identifier = "global"): Promise<void> => {
    if ("db" in context) {
        const limiter = createRatelimit(operation, context.db, "open");

        await limiter.resetUsedTokens(identifier);
    } else {
        // Action context — delegate to internal mutation
        const actionContext = context as ActionContext;

        await actionContext.runMutation(internal.lib.rate_limiter_mutations.resetRateLimit, {
            identifier,
            key: operation,
        });
    }
};

/**
 * The bucket one share link is counted against. The token itself is never stored:
 * a rate-limit row holds only its SHA-256, so a read of the limits table yields no
 * share token. Callers must check the token exists first (see the share handlers):
 * an unknown token has no link to count against, and writing a row for it would let
 * random tokens grow the table.
 */
export const shareLinkBucket = async (publicAccessToken: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicAccessToken));

    return `share:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};
