# BACKEND LIB — SHARED PRIMITIVES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Background model calls follow the user's model filter rules.** `getUtilityModel`
  (`backend/lunora/lib/utility-model.ts`) takes the user's `modelFilterRules` in its
  context (`loadModelFilterRules`; the type refuses a `userId` without them), picks the
  first candidate the same predicate as the backup model allows, and hands the rules to the
  gateway (where `requireZDR` / `denyDataCollection` route). When none is allowed it throws
  `NoAllowedUtilityModelError` and the step is skipped (the low-risk classifier, which is
  `strict`, fails closed = ask). Titles, categories, summaries and follow-ups build their own
  agent: use `resolveBackgroundModel` there, never a bare `getAgent(DEFAULT_…)`.

- **Claim-once and crypto primitives** — `lib/claim-once.ts`
  (`idempotencyClaims`: messenger events, trigger webhooks, queue jobs) and
  `lib/crypto.ts` (`timingSafeEqual`, HMAC/digest helpers, the one
  `SIGNED_REQUEST_WINDOW_MS` for third-party webhooks). Do not add another
  dedupe table or another comparison loop.

- **Storage access** — user files are PRIVATE. Server code reads them through
  `ctx.storage` (`lib/storage-read.ts`), never over HTTP; anything that must
  hand a URL out (download link, model provider fetching an attachment) gets a
  short-lived SIGNED URL from `ctx.storage.getSignedUrl`. Serving those is the
  APP's job — `lib/signed-storage.ts`, mounted as catch-all `GET /*` LAST in
  `http.ts` (keys contain slashes). `ctx.storage.getUrl` is an UNSIGNED URL
  nothing serves — do not use it. Needs `STORAGE_SIGNING_SECRET` (required
  outside development). **`verifySignedUrl`'s `expectedHost` wants a full
  ORIGIN** (`http://localhost:8788`) despite its name; a bare `host:port` fails
  every signature as `bad_signature`. There is NO public bucket
  (`R2_PUBLIC_URL_BASE` is gone): nothing persists a URL to our own storage.
  Messages store `storage:<key>` refs (`lib/storage-ref.ts`), re-signed on READ
  by `agent/stored-media.ts` — in the model context builder
  (`agent/client/search.ts`) and in the UI queries (`agent/display-media.ts`,
  bucketed expiry so a cached query result stays stable); vault rows sign their
  `key` on read (`vault/lib/display-url.ts`). A user message's media is only
  signed when its key belongs to one of that message's `fileIds`, and every
  client-supplied file id passes `agent_files.getFileForUser` (grant in
  `chatFileAccess`, or already attached in a thread the caller can read).
  **Bytes never ride in an RPC body** — Lunora caps a JSON RPC request at
  1 MiB (`413`). **Every upload goes over TUS to the upload route**
  (`lib/upload-route.ts`: `POST|PATCH|HEAD|DELETE /uploads[/:id]` for the
  session, `/api/v1/uploads` for API keys with `knowledge:write`) —
  `@lunora/storage/upload`'s `createUploadHandler` over
  `createR2BindingUploadStorage(env.FILES)`, no S3 credentials, the same under
  `lunora dev`. The web side is `apps/web/src/lib/upload/upload-file.ts`
  (`@lunora/client/upload`'s TUS adapter, 5 MiB chunks, progress; the bearer in
  the `Authorization` header, never the URL). The handler is built PER REQUEST
  for the resolved caller: the object key is `uploads/<userId>/<generatedId>`
  (never client-chosen — the codegen advisor ERRORs on a storage key taken
  from args), in-progress state lives under `upload-state/<userId>/` (another
  caller's upload id is a 404), a create declaring more than its declared
  type's chat cap (`uploadLimitFor`) or no size is a 413, a type off
  `UPLOAD_ALLOWED_MIME` a 415, each create is charged to `uploads/create`, and
  `GET` is a 405. That is only the client's DECLARATION: the finalize
  procedures take the staged object by `uploadId` alone, rebuild its key from
  the caller's identity and check the REAL bytes (`takeStagedUpload`: size cap,
  allowlist, leading bytes, then the staging object is deleted) —
  `file.finalizeChatUpload` dedupes into `agent-files/<sha256>`,
  `vault_functions.saveVaultFile` moves it to a server-minted key (5 MB cap),
  `chat_import_functions.startImportJob` hands the staging key to the import
  workflow, which deletes it when done. The route schedules a reap of each
  staging key an hour after its upload is created; the shard housekeeping sweep
  (`file.sweepStagedChatUploads`) is the backstop and also drops upload state
  untouched for an hour. There is no signed `PUT` path any more.
