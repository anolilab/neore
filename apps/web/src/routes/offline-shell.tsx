import { createFileRoute } from "@tanstack/react-router";

/**
 * The desktop shell's offline app shell (`public/offline-shell-sw.js`). Only the root route renders on the server, and
 * the root's `beforeLoad` never reads the session for this path (`src/lib/root-before-load.ts`), so the HTML is
 * nobody's and safe to keep on disk. No component: a lazy one would only add a chunk to the client's first load.
 */
export const Route = createFileRoute("/offline-shell")({
    ssr: false,
});
