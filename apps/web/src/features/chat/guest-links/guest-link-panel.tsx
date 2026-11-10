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

/** Where a guest opens the link: the token rides in the fragment, which never reaches a server log. */
export const guestLinkUrl = (linkToken: string): string => `${globalThis.location.origin}/guest#${linkToken}`;

/** The backend's code for a refusal (`chat/guest-links.ts`): its own `data.code`, else the standard one. */
const errorCode = (error: unknown): unknown => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return data?.code ?? code;
};

interface GuestLinkPanelProps {
    /** A locked chat holds no guest link (`createGuestLink` refuses one): its notes stay readable, no new link is made. */
    locked?: boolean;

    /**
     * Revokes the link, asking first when `waitingCount` notes would be deleted (`useGuestLinkRevoke`, held outside the share
     * menu); `false` when the owner declined.
     */
    revokeLink: (waitingCount: number) => Promise<boolean>;
    threadId: string;
}

/** The owner's guest link for a thread: make, copy and revoke it, and see what guests left, waiting or sent. */
const GuestLinkPanel: FC<GuestLinkPanelProps> = ({ locked = false, revokeLink, threadId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    // Only its hash is stored: the link can be shown once, right after it is made, and only in the chat it was made for.
    const [madeLink, setMadeLink] = useState<{ threadId: string; url: string }>();
    // A locked chat answers only with its live passcode proof, as the rest of the thread does.
    const unlockProof = useUnlockProof(threadId);
    const linkQuery = useQuery(crpc.chat.guest_links.getGuestLink.queryOptions({ threadId: threadId as Id<"threads">, unlockProof }));
    const { data } = linkQuery;
    // The token comes back once: it is not kept in the mutation cache after the panel closes.
    const create = useMutation(crpc.chat.guest_links.createGuestLink.mutationOptions({ gcTime: 0 }));
    // After a revoke, focus goes to "Create guest link" once it shows, not to the page: the Revoke button is gone.
    const focusCreateRef = useRef(false);
    const [revoking, setRevoking] = useState(false);
    // Read again once a round trip is back: the owner can have moved to another chat meanwhile.
    const threadIdRef = useRef(threadId);

    useEffect(() => {
        threadIdRef.current = threadId;
    }, [threadId]);

    const reportError = (error: unknown) => {
        switch (errorCode(error)) {
            case "CONFLICT": {
                toast.error(t`Revoke the earlier guest link first, then make a new one.`);

                return;
            }
            case "GUEST_LINK_ENDED": {
                toast.error(t`That guest link has ended.`);

                return;
            }
            case "GUEST_LINK_NOT_ALLOWED": {
                toast.error(t`This chat cannot have a guest link.`);

                return;
            }
            case "GUEST_NOTE_BEING_SENT": {
                toast.info(t`That message is being sent.`);

                return;
            }
            case "GUEST_NOTE_GONE": {
                toast.error(t`That message is no longer waiting.`);

                return;
            }
            case "GUEST_NOTES_WAITING": {
                toast.error(t`Guest messages from an earlier link are still waiting.`);

                return;
            }
            case "THREAD_LOCKED": {
                toast.error(t`This chat is locked. Unlock it and try again.`);

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
        const forThread = threadId;

        create.mutate(
            { threadId: forThread as Id<"threads"> },
            {
                onError: reportError,
                onSuccess: ({ linkToken }) => {
                    // A link made for a chat the panel no longer shows is not shown in another.
                    if (threadIdRef.current === forThread) {
                        setMadeLink({ threadId: forThread, url: guestLinkUrl(linkToken) });
                    }
                },
            },
        );
    };

    const waitingCount = data?.messages.filter((note) => note.status === "held").length ?? 0;

    const handleRevoke = async () => {
        const forThread = threadId;

        setRevoking(true);

        try {
            if (await revokeLink(waitingCount)) {
                setMadeLink((made) => (made?.threadId === forThread ? undefined : made));
                focusCreateRef.current = true;
            }
        } catch (error) {
            reportError(error);
        }

        setRevoking(false);
    };

    const linkUrl = madeLink?.threadId === threadId ? madeLink.url : undefined;

    const handleCopy = () => {
        if (linkUrl) {
            void navigator.clipboard
                .writeText(linkUrl)
                .then(() => toast.success(t`Guest link copied`))
                .catch(() => toast.error(t`The link could not be copied. Select it and copy it yourself.`));
        }
    };

    const expiresAt = data?.link ? formatDateTime(data.link.expiresAt, i18n.locale) : undefined;

    return (
        <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">{t`Anyone with a guest link can leave you a message here. Nothing they write runs on its own.`}</p>
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
