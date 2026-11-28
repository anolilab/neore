import { createFileRoute } from "@tanstack/react-router";

/**
 * Every old settings page. Settings open in the modal now: the dashboard layout's `beforeLoad` redirects these paths
 * to it (`settings-link.ts`), so this route only makes them match. The OAuth callback keeps its own route.
 */
export const Route = createFileRoute("/dashboard/settings/$")({
    component: () => null,
});
