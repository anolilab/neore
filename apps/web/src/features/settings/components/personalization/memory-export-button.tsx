"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef } from "react";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";

/** Hand the text to the browser as a `.md` download. */
const saveMarkdown = (markdown: string, filename: string): void => {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    // `appendChild`, not `append`: the Workers ambient types shadow the DOM `ParentNode.append` overload.
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Some browsers start the download after `click()` returns: the URL is revoked once it has begun.
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 0);
};

/**
 * Downloads the user's memories as a Markdown file, built by the server from what is stored (pinned first, then by
 * type, with dates and where each came from). Shown with memory off too: what is stored can still be read.
 */
const MemoryExportButton: FC = () => {
    const { t } = useLingui();
    const errorId = useId();
    const { authClient } = useAuth();
    // Until the session says who is signed in, a click could not tell whose file it saves: the button waits.
    const { data: session } = useAuthSession();
    const sessionKnown = session?.user.id !== undefined;
    // Cleared by the unmount cleanup: an answer that arrives after the button left the page saves nothing.
    const mounted = useRef(false);

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    const { error, isPending, mutateAsync } = useMutation({
        ...useLunoraActionOptions(api.memory.markdown_export.exportMemoriesMarkdown),
        // Lunora actions are not queued: offline, the click fails at once and says so instead of waiting for a connection.
        networkMode: "always",
        retry: 0,
    });

    // Who is signed in at this moment, read from the session store itself rather than a value a render left behind.
    const signedInUserId = (): string | undefined => authClient.$store.atoms.session?.get().data?.user.id;

    const download = async (): Promise<void> => {
        const startedBy = signedInUserId();
        // A failure is shown from the mutation's own `error`; here it only means there is nothing to save.
        const result = await mutateAsync({}).catch(() => undefined);

        // The previous person's memories, if the account changed or signed out meanwhile: dropped, never saved.
        if (result === undefined || !mounted.current || startedBy === undefined || signedInUserId() !== startedBy) {
            return;
        }

        // Named by the day the server dated it (the user's timezone), the same day as its header.
        saveMarkdown(result.markdown, `memories-${result.day}.md`);
    };

    return (
        <div className="space-y-1">
            <Button
                aria-busy={isPending}
                aria-describedby={error ? errorId : undefined}
                className="w-full"
                disabled={isPending || !sessionKnown}
                // The button keeps focus while the file is prepared, so the keyboard is not sent back to the page.
                focusableWhenDisabled
                onClick={() => {
                    void download();
                }}
                variant="outline"
            >
                <DownloadIcon aria-hidden="true" className="mr-2 h-4 w-4" />
                {isPending ? t`Preparing your memories…` : t`Download memories (Markdown)`}
            </Button>
            <span className="sr-only" role="status">
                {isPending ? t`Preparing your memories…` : ""}
            </span>
            {error && (
                <p className="text-destructive text-xs" id={errorId} role="alert">
                    {t`The download could not be prepared. Please try again in a moment.`}
                </p>
            )}
        </div>
    );
};

export default MemoryExportButton;
