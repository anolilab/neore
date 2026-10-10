import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";

/**
 * Where the provider sends the browser back after consent. Completion runs HERE,
 * as the signed-in user, because the backend binds each OAuth `state` to the
 * user who started the flow and refuses anyone else.
 */
const OAuthCallback = () => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const { mutateAsync: completeOAuth } = useMutation(useLunoraActionOptions(api.connectors.oauth.completeConnectorOAuth));
    const searchParams = Route.useSearch() as { code?: string; error?: string; error_description?: string; state?: string };
    const [message, setMessage] = useState(() => t`Completing the connection...`);
    // The authorization code is single-use: a second run (StrictMode, a re-render
    // with new search params) would burn the state and report a false failure.
    const started = useRef(false);

    useEffect(() => {
        if (started.current) {
            return;
        }

        started.current = true;

        const finish = async (): Promise<void> => {
            const backToConnectors = async () => await navigate({ replace: true, to: "/dashboard/settings/connectors" });

            if (searchParams.error) {
                // The provider's own text; shown, never interpreted.
                const reason = searchParams.error === "access_denied" ? t`Access was not granted.` : (searchParams.error_description ?? searchParams.error);

                setMessage(t`The connection was not completed.`);
                toast.error(t`The connection was not completed: ${reason}`);
                await backToConnectors();

                return;
            }

            if (!searchParams.code || !searchParams.state) {
                setMessage(t`This link is incomplete.`);
                toast.error(t`Invalid OAuth callback`);
                await backToConnectors();

                return;
            }

            try {
                const { accountLabel, kind, name } = await completeOAuth({ code: searchParams.code, state: searchParams.state });

                setMessage(t`${name} connected.`);
                toast.success(accountLabel ? t`${name} connected to ${accountLabel}` : t`${name} connected`);

                // A sign-in to one of the user's own MCP servers returns to that list.
                if (kind === "mcp") {
                    await navigate({ replace: true, to: "/dashboard/settings/chat/mcp" });

                    return;
                }
            } catch (error) {
                setMessage(t`The connection could not be completed.`);
                toast.error(error instanceof Error && error.message ? error.message : t`Failed to connect`);
            }

            await backToConnectors();
        };

        void finish();
    }, [completeOAuth, navigate, searchParams, t]);

    return (
        <main className="flex min-h-screen items-center justify-center">
            <div className="text-center">
                <h1 className="text-lg font-semibold">{t`Connecting...`}</h1>
                <p aria-live="polite" className="text-muted-foreground mt-2 text-sm" role="status">
                    {message}
                </p>
            </div>
        </main>
    );
};

export const Route = createFileRoute("/dashboard/settings/connectors/callback")({
    component: OAuthCallback,
});
