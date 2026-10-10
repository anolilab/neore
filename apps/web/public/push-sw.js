/**
 * Web Push handlers, imported by the generated service worker
 * (`scripts/generate-sw.mjs` → `importScripts`). Plain JS and not bundled: it
 * runs in the worker scope, where nothing from the app is available.
 *
 * The payload is `{ title, body, data: { link, tag } }`: `@lunora/notify`'s
 * web-push provider sends `{ title, body, data, image, badge }`, and
 * `backend/lunora/notifications/push.ts` fills it. `link` is an in-app PATH (the
 * server refuses anything else); it is resolved against this origin here as
 * well, so a notification can never open another site.
 */
/* eslint-disable no-restricted-globals -- `self` is the service worker scope. */

self.addEventListener("push", (event) => {
    let data = {};

    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { body: event.data ? event.data.text() : "" };
    }

    const title = typeof data.title === "string" && data.title ? data.title : "Neore";
    const extra = data.data && typeof data.data === "object" ? data.data : {};
    const link = typeof extra.link === "string" && extra.link.startsWith("/") && !extra.link.startsWith("//") ? extra.link : "/dashboard";

    event.waitUntil(
        self.registration.showNotification(title, {
            badge: "/pwa-icon.svg",
            body: typeof data.body === "string" ? data.body : "",
            data: { link },
            icon: "/pwa-icon.svg",
            // One notification per server row: a redelivered push replaces, not stacks.
            tag: typeof extra.tag === "string" ? extra.tag : undefined,
        }),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    const target = new URL(event.notification.data?.link ?? "/dashboard", self.location.origin);

    if (target.origin !== self.location.origin) {
        return;
    }

    event.waitUntil(
        (async () => {
            const sameOrigin = (client) => new URL(client.url).origin === self.location.origin;
            // Reuse an open tab of the app rather than opening another one —
            // one this worker controls first: `navigate()` rejects on any other.
            const controlled = await self.clients.matchAll({ type: "window" });
            const existing = controlled.find(sameOrigin) ?? (await self.clients.matchAll({ includeUncontrolled: true, type: "window" })).find(sameOrigin);

            if (existing && "navigate" in existing) {
                const navigated = await existing.navigate(target.href).then(
                    (client) => client ?? existing,
                    // Uncontrolled, or the navigation was refused: open a window instead.
                    () => undefined,
                );

                if (navigated) {
                    await navigated.focus().catch(() => undefined);

                    return;
                }
            }

            await self.clients.openWindow(target.href);
        })(),
    );
});
