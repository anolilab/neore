import { createFileRoute } from "@tanstack/react-router";

/**
 * The desktop shell's offline app shell (`src/lib/offline-shell.ts`). Only the root route renders on the server, and
 * the root's `beforeLoad` never reads the session for this path, so the HTML is nobody's and safe to keep on disk.
 */
export const Route = createFileRoute("/offline-shell")({
    component: () => null,
    ssr: false,
});
