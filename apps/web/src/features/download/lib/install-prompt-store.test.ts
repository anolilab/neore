import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics/posthog-client", () => {
    return { captureException };
});

type Store = typeof import("./install-prompt-store");

const APP = "/manifest.json";
const PAGE = "/page-manifest/page-1";

const loadStore = async (): Promise<Store> => {
    vi.resetModules();

    return import("./install-prompt-store");
};

const setManifestHref = (href: string): void => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');

    if (!link) {
        link = document.createElement("link");
        link.rel = "manifest";
        document.head.appendChild(link);
    }

    link.setAttribute("href", href);
};

const dispatchBeforeInstallPrompt = (prompt: () => Promise<void>): Event => {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt });

    globalThis.dispatchEvent(event);

    return event;
};

describe("install-prompt-store", () => {
    beforeEach(() => {
        captureException.mockReset();
        setManifestHref(APP);
    });

    afterEach(() => {
        document.head.querySelector('link[rel="manifest"]')?.remove();
        vi.restoreAllMocks();
    });

    it("suppresses the browser banner for a page, but not for the Neore app", async () => {
        const store = await loadStore();

        const appEvent = dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));

        expect(appEvent.defaultPrevented).toBe(false);
        expect(store.getInstallPromptFor(APP)).not.toBeNull();

        setManifestHref(PAGE);
        const pageEvent = dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));

        expect(pageEvent.defaultPrevented).toBe(true);
    });

    it("notifies subscribers when a prompt is captured, and stops after unsubscribe", async () => {
        const store = await loadStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribeInstallPrompt(listener);

        dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("offers a prompt only for the manifest it was captured under", async () => {
        const store = await loadStore();

        dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));

        expect(store.getInstallPromptFor(APP)).not.toBeNull();
        expect(store.getInstallPromptFor(PAGE)).toBeNull();
    });

    it("keeps each manifest's prompt when the page swaps the link, so the app's offer survives a visit", async () => {
        const store = await loadStore();

        const appEvent = dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));

        setManifestHref(PAGE);
        const pageEvent = dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));

        expect(store.getInstallPromptFor(APP)).toBeNull();
        expect(store.getInstallPromptFor(PAGE)).toBe(pageEvent);

        setManifestHref(APP);

        expect(store.getInstallPromptFor(PAGE)).toBeNull();
        expect(store.getInstallPromptFor(APP)).toBe(appEvent);
    });

    it("offers nothing once the link has moved away from the manifest the prompt was captured under", async () => {
        const store = await loadStore();

        dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));
        setManifestHref(PAGE);

        expect(store.getInstallPromptFor(APP)).toBeNull();
        expect(store.getInstallPromptFor(PAGE)).toBeNull();
    });

    it("shows the prompt once when installed, then clears it", async () => {
        const store = await loadStore();
        const prompt = vi.fn().mockResolvedValue(undefined);

        dispatchBeforeInstallPrompt(prompt);
        await store.installApp(APP);
        await store.installApp(APP);

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(store.getInstallPromptFor(APP)).toBeNull();
    });

    it("does nothing when asked to install a manifest that has no matching prompt", async () => {
        const store = await loadStore();
        const prompt = vi.fn().mockResolvedValue(undefined);

        dispatchBeforeInstallPrompt(prompt);
        await store.installApp(PAGE);

        expect(prompt).not.toHaveBeenCalled();
        expect(store.getInstallPromptFor(APP)).not.toBeNull();
    });

    it("attributes an accepted install to the manifest it was offered for, even if the link moved during the dialog", async () => {
        const store = await loadStore();
        // While the dialog is open the page navigates, then the browser reports the install.
        const prompt = vi.fn(async () => {
            setManifestHref(PAGE);
            globalThis.dispatchEvent(new Event("appinstalled"));
        });

        dispatchBeforeInstallPrompt(prompt);
        await store.installApp(APP);

        expect(store.hasInstalledHref(APP)).toBe(true);
        expect(store.hasInstalledHref(PAGE)).toBe(false);
    });

    it("records the installed manifest, clears its prompt, and leaves other manifests uninstalled", async () => {
        const store = await loadStore();

        setManifestHref(PAGE);
        dispatchBeforeInstallPrompt(vi.fn().mockResolvedValue(undefined));
        globalThis.dispatchEvent(new Event("appinstalled"));

        expect(store.getInstallPromptFor(PAGE)).toBeNull();
        expect(store.hasInstalledHref(PAGE)).toBe(true);
        expect(store.hasInstalledHref(APP)).toBe(false);
    });

    it("reports a refused prompt instead of throwing into the click handler", async () => {
        const store = await loadStore();
        const refusal = new Error("prompt refused");

        dispatchBeforeInstallPrompt(vi.fn().mockRejectedValue(refusal));

        await expect(store.installApp(APP)).resolves.toBeUndefined();
        expect(captureException).toHaveBeenCalledWith(refusal, { context: "install_app_prompt" });
    });
});
