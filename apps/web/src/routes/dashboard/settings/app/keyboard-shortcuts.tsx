import { createFileRoute } from "@tanstack/react-router";

import KeyboardShortcutsSettings from "@/features/settings/components/keyboard/keyboard-shortcuts-settings";

export const Route = createFileRoute("/dashboard/settings/app/keyboard-shortcuts")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    component: KeyboardShortcutsSettings,
});
