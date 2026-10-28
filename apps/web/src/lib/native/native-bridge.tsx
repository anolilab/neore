import { useLingui } from "@lingui/react/macro";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { JSX } from "react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { trackEvent } from "@/lib/analytics";

import { completeNativeSignIn, getNativeDeviceStatus, onNativeCompose, onNativeDraft, onNativeFiles, onNativeSignIn } from "./bridge";

/** Only the desktop shell ever loads it. */
const DeviceRelay = lazy(async () => await import("@/features/devices/components/device-relay"));

/**
 * Lazy: the chat module is only needed inside the shell. The request waits in
 * a request channel until the NEW-thread composer takes it and sends it
 * (`features/chat/core/utils/composer-submit.ts`).
 */
const requestSend = async (text: string): Promise<void> => {
    const { requestComposerSubmit } = await import("@/features/chat/core/utils/composer-submit");

    requestComposerSubmit({ text });
};

/** Lazy, like `requestSend`: the new-thread composer takes the files and attaches them (`composer-submit.ts`). */
const requestAttach = async (files: File[]): Promise<void> => {
    const { requestComposerAttach } = await import("@/features/chat/core/utils/composer-submit");

    requestComposerAttach({ files });
};

/**
 * Mounted once in the root; does nothing outside the desktop shell. Inside it:
 *
 * - text from the Quick Composer, a `neore://new?text=` link or a share is sent
 *   as a new chat; files dropped on the dock icon are attached to a new chat;
 * - a system-browser sign-in the shell received is exchanged for a session
 *   cookie on this origin, then the page reloads signed in;
 * - on desktop, for a signed-in account and after first paint, the device
 *   relay runs (`features/devices`): agent calls to this computer go to the
 *   shell, which asks the user in its own window.
 */
const NativeBridge = (): JSX.Element | null => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const router = useRouter();
    const { authClient } = useAuth();
    const { data: session } = authClient.useSession();
    const afterFirstPaint = useAfterFirstPaint();
    const [hasDeviceTools, setHasDeviceTools] = useState(false);

    useEffect(() => {
        void getNativeDeviceStatus().then((status) => setHasDeviceTools(status !== undefined));
    }, []);

    const openNewChat = useCallback(async (): Promise<void> => {
        const { pathname } = router.state.location;

        if (pathname !== "/chat" && pathname !== "/chat/") {
            await navigate({ to: "/chat" });
        }
    }, [navigate, router]);

    useEffect(
        () =>
            onNativeCompose((text) => {
                void (async () => {
                    await requestSend(text);
                    await openNewChat();
                })();
            }),
        [openNewChat],
    );

    useEffect(
        () =>
            onNativeDraft((text) => {
                void (async () => {
                    // Into the composer, not sent: a link cannot send a message the user did not submit.
                    const { requestComposerRestore } = await import("@/features/chat/core/utils/composer-restore");

                    requestComposerRestore({ append: true, files: [], text });
                    await openNewChat();
                })();
            }),
        [openNewChat],
    );

    useEffect(
        () =>
            onNativeFiles((files) => {
                void (async () => {
                    await requestAttach(files);
                    await openNewChat();
                })();
            }),
        [openNewChat],
    );

    useEffect(
        () =>
            onNativeSignIn((signIn) => {
                void (async () => {
                    if (await completeNativeSignIn(signIn)) {
                        // Sent before the reload; analytics may not flush on unload, so this one can be lost.
                        trackEvent("desktop_signed_in", {});
                        // A full load: SSR, the RPC token and every cached query
                        // must all start from the new session.
                        globalThis.location.assign("/chat");
                    } else {
                        toast.error(t`Signing in through your browser did not work. Try again.`);
                    }
                })();
            }),
        [t],
    );

    if (!hasDeviceTools || !afterFirstPaint || !session?.user || session.user.isAnonymous === true) {
        return null;
    }

    return (
        <Suspense fallback={null}>
            <DeviceRelay />
        </Suspense>
    );
};

export default NativeBridge;
