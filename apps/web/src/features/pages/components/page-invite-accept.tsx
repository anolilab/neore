"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { FC } from "react";
import { useEffect, useRef } from "react";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";
import { notePageShard } from "@/lib/lunora/shard-routing";

/** Spends a page invite link for the signed-in user, then opens the page. */
const PageInviteAccept: FC<{ token: string }> = ({ token }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const startedRef = useRef(false);
    // An action: the invitee's call hops to the page owner's shard to redeem it.
    const { error, mutate } = useMutation(useLunoraActionOptions(api.pages.sharing.acceptPageInvite));

    useEffect(() => {
        // Once: the invite is single-use, and a second call would report it spent.
        if (startedRef.current) {
            return;
        }

        startedRef.current = true;
        mutate(
            { token },
            {
                onSuccess: ({ ownerId, pageId }) => {
                    // The page lives on its owner's shard (`lib/lunora/shard-routing.ts`).
                    notePageShard(pageId, ownerId);
                    void navigate({ params: { pageId }, replace: true, to: "/pages/$pageId" });
                },
            },
        );
    }, [mutate, navigate, token]);

    if (error) {
        return (
            <div className="p-8 text-sm" role="alert">
                <p className="font-medium">{t`This invite is not valid`}</p>
                <p className="text-muted-foreground">{t`It may have expired, been revoked, or already been used. Ask for a new link.`}</p>
                <Link className="text-primary mt-4 inline-block underline" to="/pages">
                    {t`Go to your pages`}
                </Link>
            </div>
        );
    }

    return (
        <p aria-live="polite" className="text-muted-foreground p-8 text-sm" role="status">
            {t`Opening the shared page…`}
        </p>
    );
};

export default PageInviteAccept;
