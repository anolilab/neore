import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import { errorCode } from "./error-code";

/** Where a guest opens the link: the token rides in the fragment, which never reaches a server log. */
export const guestLinkUrl = (linkToken: string): string => `${globalThis.location.origin}/guest#${linkToken}`;

interface GuestLinkPanelProps {
    /** A locked chat holds no guest link (`createGuestLink` refuses one): its notes stay readable, no new link is made. */
    locked?: boolean;

    /**
     * Revokes the link shown (`linkId`), asking first when the waiting notes shown (their ids) would be deleted
     * (`useGuestLinkRevoke`, held outside the share menu); `false` when the owner declined.
     */
    revokeLink: (linkId: string, waitingNotes: string[]) => Promise<boolean>;
    threadId: string;
}

/** The owner's guest link for a thread: make, copy and revoke it, and see what guests left, waiting or sent. */
const GuestLinkPanel: FC<GuestLinkPanelProps> = ({ locked = false, revokeLink, threadId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    // Only its hash is stored: the link can be shown once, right after it is made.
    const [madeLink, setMadeLink] = useState<{ id: string; url: string }>();
    // A locked chat answers only with its live passcode proof, as the rest of the thread does.
    const unlockProof = useUnlockProof(threadId);
    const linkQuery = useQuery(crpc.chat.guest_links.getGuestLink.queryOptions({ threadId: threadId as Id<"threads">, unlockProof }));
    const { data } = linkQuery;
    // The token comes back once: it is not kept in the mutation cache after the panel closes.
    const create = useMutation(crpc.chat.guest_links.createGuestLink.mutationOptions({ gcTime: 0 }));
    // After a revoke, focus goes to "Create guest link" once it shows, not to the page: the Revoke button is gone.
    const focusCreateRef = useRef(false);
    const [revoking, setRevoking] = useState(false);
    // A link past its end is not live, even before the next read says so (a read reruns on writes, not on time): the panel
    // re-renders when it ends.
    const [now, setNow] = useState(() => Date.now());
    const linkEnd = data?.link?.expiresAt;
    const live = linkEnd !== undefined && linkEnd > now;

    useEffect(() => {
        if (linkEnd === undefined) {
            return undefined;
        }

        const current = Date.now();

        // Ended already, while the panel still counts it live (it ended before the read answered, or the timer fired late):
        // catch up once. Once `now` has passed the end there is nothing left to do.
        if (linkEnd <= current) {
            if (now < linkEnd) {
                setNow(current);
            }

            return undefined;
        }

        // A timeout to the end (a link lives a day, `GUEST_LINK_TTL_MS`, well within a browser timeout), armed again each time
        // `now` moves while the link is still ahead: a timer can fire early, or the clock move back.
        const timer = setTimeout(() => setNow(Date.now()), linkEnd - current);

        return () => clearTimeout(timer);
    }, [linkEnd, now]);

    const reportError = (error: unknown) => {
        switch (errorCode(error)) {
            case "CONFLICT": {
                toast.error(t`Revoke the earlier guest link first, then make a new one.`);

                return;
            }
            case "GUEST_LINK_ENDED": {
                // Revoked or replaced elsewhere since the owner looked: show them the link as it is now.
                toast.error(t`The guest link was replaced or has ended.`);
                void linkQuery.refetch();

                return;
            }
            case "GUEST_LINK_NOT_ALLOWED": {
                toast.error(t`This chat cannot have a guest link.`);

                return;
            }
            case "GUEST_NOTES_WAITING": {
                toast.error(t`Guest messages from an earlier link are still waiting.`);

                return;
            }
            case "THREAD_LOCKED": {
                // `createGuestLink` refuses a locked chat even once it is unlocked.
                toast.error(t`A locked chat cannot have a guest link.`);

                return;
            }
            case "TOO_MANY_REQUESTS": {
                toast.error(t`Too many requests. Please try again in a moment.`);

                return;
            }
            default: {
                toast.error(t`That did not work. Please try again.`);
            }
        }
    };

    const handleCreate = () => {
        create.mutate(
            { threadId: threadId as Id<"threads"> },
            { onError: reportError, onSuccess: ({ id, linkToken }) => setMadeLink({ id, url: guestLinkUrl(linkToken) }) },
        );
    };

    // The waiting notes the owner sees: a revoke deletes these and no other (`revokeGuestLink`'s `confirmedNotes`).
    const waitingNotes = data?.messages.filter((note) => note.status === "held").map((note) => note.id) ?? [];

    const shownLinkId = data?.link?.id;

    const handleRevoke = async () => {
        setRevoking(true);

        try {
            // The link the owner sees: one replaced since (another tab) is refused, not revoked in its place.
            if (shownLinkId !== undefined && (await revokeLink(shownLinkId, waitingNotes))) {
                setMadeLink(undefined);
                focusCreateRef.current = true;
            }
        } catch (error) {
            reportError(error);
        }

        setRevoking(false);
    };

    // Shown only while the live read still holds that very link, by id: not once it is revoked, replaced or past its end, and
    // never in another chat, whose link has another id.
    const linkUrl = live && madeLink !== undefined && madeLink.id === data?.link?.id ? madeLink.url : undefined;

    const handleCopy = () => {
        if (linkUrl) {
            void navigator.clipboard
                .writeText(linkUrl)
                .then(() => toast.success(t`Guest link copied`))
                .catch(() => toast.error(t`The link could not be copied. Select it and copy it yourself.`));
        }
    };

    const expiresAt = live ? formatDateTime(linkEnd, i18n.locale) : undefined;

    return (
        <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">{t`Anyone with a guest link can leave you a message here. Nothing they write runs on its own.`}</p>
            {/* Mounted from the start, so the text that appears in it is announced. */}
            <p className="text-muted-foreground text-sm empty:hidden" role="status">
                {linkQuery.isPending ? t`Loading the guest link…` : null}
            </p>
            {linkQuery.isError && <p role="alert">{t`The guest link could not be loaded.`}</p>}
            {locked && <p className="text-muted-foreground text-sm">{t`A locked chat cannot have a guest link.`}</p>}
            {linkUrl && (
                <div className="flex gap-2">
                    <Input aria-label={t`Guest link`} readOnly value={linkUrl} />
                    <Button onClick={handleCopy} variant="outline">
                        {t`Copy`}
                    </Button>
                </div>
            )}
            {expiresAt ? (
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm">{t`Link active until ${expiresAt}`}</p>
                    <Button
                        disabled={revoking}
                        onClick={() => {
                            void handleRevoke();
                        }}
                        variant="outline"
                    >
                        {t`Revoke link`}
                    </Button>
                </div>
            ) : (
                <Button
                    disabled={locked || create.isPending || !linkQuery.isSuccess}
                    onClick={handleCreate}
                    ref={(button) => {
                        if (!(button && focusCreateRef.current)) {
                            return;
                        }

                        focusCreateRef.current = false;
                        button.focus();
                    }}
                >
                    {t`Create guest link`}
                </Button>
            )}
            {data && data.messages.length > 0 && (
                <ul aria-label={t`Guest messages`} className="flex flex-col gap-2">
                    {data.messages.map((note) => (
                        <li className="border-border flex flex-col gap-2 rounded-md border p-2" key={note.id}>
                            <p className="text-sm break-words whitespace-pre-wrap">{note.text}</p>
                            <Badge className="self-start" variant={note.status === "held" ? "secondary" : "default"}>
                                {note.status === "held" ? t`Waiting` : t`Sent`}
                            </Badge>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default GuestLinkPanel;
