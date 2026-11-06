# PAGES — AGENT NOTES

## INVARIANTS

- **Pages** (`backend/lunora/pages/`, `apps/web/src/features/pages/`) — their
  own `pages` table, not `documents` (which requires a `threadId`). **Every
  content write goes through `functions.ts#writeContent`**: it re-anchors or
  orphans comment threads and records the version snapshot (one per author per
  10-minute window; agent edits and restores always get their own). A comment
  anchor is a `comment` mark with `commentId` — the server
  (`comment-anchors.ts`) and the editor (`lib/comment-mark.ts`) share that
  contract by name. A `comment`-permission user adds the anchor through
  `createPageComment`, which refuses any document that differs from the stored
  one in more than comment marks. As with threads, `isPublic` grants nothing:
  the public read is `pages_sharing.getPublicPage` by token, marks stripped.
  Saves are optimistic-concurrency: `revision` moves on every write,
  `contentRevision` only on real content changes, and a stale `baseRevision`
  is a CONFLICT (`data.code = PAGE_REVISION_CONFLICT`) only if content moved
  past it — comment activity alone never makes a collaborator's save stale.
