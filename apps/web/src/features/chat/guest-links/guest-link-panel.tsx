import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import { errorCode } from "./error-code";
import type { GuestNoteSendOutcome } from "./use-guest-note-send";

/** Where a guest opens the link: the token rides in the fragment, which never reaches a server log. */
export const guestLinkUrl = (linkToken: string): string => `${globalThis.location.origin}/guest#${linkToken}`;

/** The longest a browser timeout can wait: a longer delay fires at once. A link ending later is checked again then. */
const MAX_TIMEOUT_MS = 2_147_483_647;

interface GuestLinkPanelProps {
    /** A locked chat holds no guest link (`createGuestLink` refuses one): its notes stay readable, no new link is made. */
    locked?: boolean;

    /**
     * Revokes the link shown (`linkId`), asking first when the waiting notes shown (their ids) would be deleted
     * (`useGuestLinkRevoke`, held outside the share menu); `false` when the owner declined.
     */
    revokeLink: (linkId: string, waitingNotes: string[]) => Promise<boolean>;
    /** The note whose Send is armed (`useGuestNoteSend`, held outside the share menu): its Dismiss stays off. */
    sendingId?: string;
    /** Sends a held note through the ordinary send with its id (`useGuestNoteSend`), so it is saved as the guest's. */
    sendNote: (messageId: string) => Promise<GuestNoteSendOutcome>;
    threadId: string;
    /** A reply is running in the thread: a note sent now would start a second run beside it, so Send waits. */
    turnRunning?: boolean;
}

/**
 * The owner's guest link for a thread: make, copy and revoke it, and review what guests left. Send hands a held note to the
 * ordinary send with its id, which marks it sent; Dismiss deletes it.
 */
const GuestLinkPanel: FC<GuestLinkPanelProps> = ({ locked = false, revokeLink, sendingId, sendNote, threadId, turnRunning = false }) => {
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
    const dismiss = useMutation(crpc.chat.guest_links.dismissHeldGuestMessage.mutationOptions());
    // Said in the status region once a sent note reads as sent; focus then moves on to the next note's Send, or the list.
    const [announcement, setAnnouncement] = useState<string>();
    const focusNextRef = useRef(false);
    const hintId = useId();
    // After a revoke, focus goes to "Create guest link" once it shows, not to the page: the Revoke button is gone.
    const focusCreateRef = useRef(false);
    const revokeButtonRef = useRef<HTMLButtonElement>(null);
    // The link ends while focus is on Revoke, which then goes: focus moves on to "Create guest link", as after a revoke.
    const keepFocusAtEnd = () => {
        if (revokeButtonRef.current !== null && revokeButtonRef.current === document.activeElement) {
            focusCreateRef.current = true;
        }
    };
    const [revoking, setRevoking] = useState(false);
    // A link past its end is not live, even before the next read says so (a read reruns on writes, not on time): the panel
    // re-renders when it ends.
    const [now, setNow] = useState(() => Date.now());
    // Counts the timer's firings, so each one re-checks even when the clock reads the same `now` (it moved back).
    const [ticks, setTicks] = useState(0);
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
                keepFocusAtEnd();
                setNow(current);
            }

            return undefined;
        }

        // A timeout to the end (a link lives a day, `GUEST_LINK_TTL_MS`, well within a browser timeout), armed again each time
        // `now` moves while the link is still ahead: a timer can fire early, or the clock move back.
        const timer = setTimeout(
            () => {
                const fired = Date.now();

                if (fired >= linkEnd) {
                    keepFocusAtEnd();
                }

                setNow(fired);
                setTicks((count) => count + 1);
            },
            Math.min(linkEnd - current, MAX_TIMEOUT_MS),
        );

        return () => clearTimeout(timer);
    }, [linkEnd, now, ticks]);

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
            {
                onError: reportError,
                onSuccess: ({ id, linkToken }) => {
                    setMadeLink({ id, url: guestLinkUrl(linkToken) });
                    // The address shows once the read holds the new link: read it now, as a live read can fall back to one-shot.
                    void linkQuery.refetch();
                },
            },
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
                void linkQuery.refetch();
            }
        } catch (error) {
            reportError(error);
        }

        setRevoking(false);
    };

    // Shown only while the live read still holds that very link, by id: not once it is revoked, replaced or past its end, and
    // never in another chat, whose link has another id.
    const linkUrl = live && madeLink !== undefined && madeLink.id === data?.link?.id ? madeLink.url : undefined;

    // The outcome is read from the returned promise, not from mutation callbacks: it still arrives once the menu closed.
    const handleSend = async (messageId: string) => {
        let outcome: GuestNoteSendOutcome;

        try {
            outcome = await sendNote(messageId);
        } catch (error) {
            reportError(error);

            return;
        }

        if (outcome !== "sent") {
            toast.info(outcome === "busy" ? t`A reply is running. Send a message once it has finished.` : t`That message was already sent.`);

            return;
        }

        const { data: after } = await linkQuery.refetch();

        if (after?.messages.some((note) => note.id === messageId && note.status === "sent")) {
            focusNextRef.current = true;
            setAnnouncement(t`Sent`);
        }
    };

    // The first waiting note's Send, or else the list, takes focus after a send: the sent note's buttons are gone.
    const takeFocusAfterSend = (element: HTMLElement | null) => {
        if (!(element && focusNextRef.current)) {
            return;
        }

        focusNextRef.current = false;
        element.focus();
    };

    const handleDismiss = (messageId: string) => {
        dismiss.mutate(
            { messageId: messageId as Id<"threadGuestMessages">, unlockProof },
            {
                onError: reportError,
                onSuccess: (result) => {
                    if (result.status === "sent") {
                        toast.info(t`That message was already sent.`);
                    }
                },
            },
        );
    };

    const handleCopy = () => {
        if (!linkUrl) {
            return;
        }

        const copyByHand = () => toast.error(t`The link could not be copied. Select it and copy it yourself.`);

        // No Clipboard API (an insecure page, an old browser): the owner copies it from the field.
        if (globalThis.navigator?.clipboard === undefined) {
            copyByHand();

            return;
        }

        void globalThis.navigator.clipboard
            .writeText(linkUrl)
            .then(() => toast.success(t`Guest link copied`))
            .catch(copyByHand);
    };

    const expiresAt = live ? formatDateTime(linkEnd, i18n.locale) : undefined;

    return (
        <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">{t`Anyone with a guest link can leave you a message here. Nothing they write runs until you send it.`}</p>
            {/* Mounted from the start, so the text that appears in it is announced. */}
            <p className="text-muted-foreground text-sm empty:hidden" role="status">
                {linkQuery.isPending ? t`Loading the guest link…` : (announcement ?? null)}
            </p>
            {turnRunning && live && waitingNotes.length > 0 && (
                <p className="text-muted-foreground text-sm" id={hintId}>
                    {t`A reply is running. Send a message once it has finished.`}
                </p>
            )}
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
                        ref={revokeButtonRef}
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
            {/* A lapsed link's notes are hidden, as the server hides them. */}
            {live && data && data.messages.length > 0 && (
                <ul aria-label={t`Guest messages`} className="flex flex-col gap-2" ref={takeFocusAfterSend} tabIndex={-1}>
                    {data.messages.map((note) => {
                        // Cut by characters, not UTF-16 units: an emoji is never split.
                        const characters = [...note.text];
                        const snippet = characters.length > 40 ? `${characters.slice(0, 40).join("")}…` : note.text;

                        return (
                            <li className="border-border flex flex-col gap-2 rounded-md border p-2" key={note.id}>
                                <p className="text-sm break-words whitespace-pre-wrap">{note.text}</p>
                                <div className="flex items-center justify-between gap-2">
                                    <Badge variant={note.status === "held" ? "secondary" : "default"}>{note.status === "held" ? t`Waiting` : t`Sent`}</Badge>
                                    {note.status === "held" && (
                                        <div className="flex gap-1">
                                            <Button
                                                aria-describedby={turnRunning ? hintId : undefined}
                                                aria-label={t`Send: ${snippet}`}
                                                disabled={turnRunning || sendingId !== undefined}
                                                onClick={() => {
                                                    void handleSend(note.id);
                                                }}
                                                ref={takeFocusAfterSend}
                                                size="sm"
                                            >
                                                {t`Send`}
                                            </Button>
                                            <Button
                                                aria-label={t`Dismiss note: ${snippet}`}
                                                disabled={dismiss.isPending || sendingId === note.id}
                                                onClick={() => handleDismiss(note.id)}
                                                size="sm"
                                                variant="ghost"
                                            >
                                                {t`Dismiss note`}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

export default GuestLinkPanel;
