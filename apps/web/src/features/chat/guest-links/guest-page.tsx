import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { HeadingLevelProvider } from "@neore/ui/components/heading";
import { Label } from "@neore/ui/components/label";
import { Textarea } from "@neore/ui/components/textarea";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FC, FormEvent } from "react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { useAction } from "@/lib/lunora/crpc";

import { guestPollInterval } from "./guest-poll";
import type { PendingPost } from "./guest-token";
import { forgetGuestToken, guestTokenFor, keepGuestToken, keepPendingPost, readPendingPost, rereadGuestToken } from "./guest-token";

/** A guest note's cap (`GUEST_MESSAGE_MAX_CHARS` in the backend). */
const MAX_CHARS = 2000;

/** The URL fragment, the only place a guest link carries its token; `undefined` on the server, where there is none. */
const subscribeToHash = (onChange: () => void): (() => void) => {
    globalThis.addEventListener("hashchange", onChange);

    return () => globalThis.removeEventListener("hashchange", onChange);
};
/** A link token's shape (`newGuestToken` in the backend): 64 lowercase hex characters. */
const LINK_TOKEN_SHAPE = /^[0-9a-f]{64}$/u;
/** The root layout's "Skip to content" anchor (`__root.tsx`), the one fragment that is no link. */
const SKIP_LINK_ANCHOR = "main-content";
const readHash = (): string => globalThis.location.hash.slice(1);
const noHashOnServer = (): undefined => undefined;

/** The backend's error code (`LunoraError#code`), wherever the client put it. */
const errorCode = (error: unknown): unknown => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return data?.code ?? code;
};

const GuestLinkPage: FC<{ linkToken: string }> = ({ linkToken }) => {
    const { t } = useLingui();
    const fieldId = useId();
    const errorId = useId();
    const [text, setText] = useState("");
    // When the last post went through: a view fetched after it that answers nothing means the link has ended. A view from
    // before it (nothing left yet, for a new guest) says nothing about the link.
    const [postedAt, setPostedAt] = useState<number>();
    const [ended, setEnded] = useState(false);
    // A post that failed keeps its request id, so sending the same text again cannot store it twice.
    const pendingRef = useRef<PendingPost | undefined>(undefined);

    // A post sent before a reload, whose reply never came, comes back into the field with its request id, so sending it again
    // is the same request. Nothing is sent before it has been read.
    const [restored, setRestored] = useState(false);

    useEffect(() => {
        void readPendingPost(linkToken).then((pending) => {
            if (pending !== undefined && pendingRef.current === undefined) {
                pendingRef.current = pending;
                setText((current) => (current === "" ? pending.text : current));
            }

            setRestored(true);

            return undefined;
        });
    }, [linkToken]);
    const queryClient = useQueryClient();
    const postNote = useAction(api.chat.guest_links.postGuestMessage);
    const readView = useAction(api.chat.guest_links.getGuestView);

    const errorMessage = (error: unknown): string => {
        switch (errorCode(error)) {
            case "BAD_REQUEST": {
                return t`This message cannot be left. Keep it short, don't start it with / or mention anyone, or try again later.`;
            }
            case "FORBIDDEN": {
                return t`This link is already in use in another browser.`;
            }
            case "NOT_FOUND": {
                return t`This link is not taking messages right now. Try again later.`;
            }
            case "TOO_MANY_REQUESTS": {
                return t`Too many messages. Please try again later.`;
            }
            default: {
                return t`The message could not be sent. Check your connection and try again.`;
            }
        }
    };

    const endLink = () => {
        setEnded(true);

        if (linkToken) {
            void forgetGuestToken(linkToken);
        }
    };

    const view = useQuery({
        queryFn: linkToken
            ? async () => {
                  const guestToken = await guestTokenFor(linkToken);

                  return guestToken === undefined ? null : await readView({ guestToken, linkToken });
              }
            : skipToken,
        queryKey: ["guest-view", linkToken],
        refetchInterval: (query) => guestPollInterval(query.state.data),
    });
    const post = useMutation({
        mutationFn: async (note: PendingPost) => {
            const guestToken = (await guestTokenFor(linkToken, { create: true })) ?? "";

            // Kept before it is sent, so a reload after a lost reply still sends it as this request.
            await keepPendingPost(linkToken, note);
            await postNote({ guestToken, linkToken, requestId: note.requestId, text: note.text });

            return guestToken;
        },
        // Awaited before the post counts as failed, so a retry cannot run before the stale copy is dropped.
        // A refused post never ends the link here: the backend also answers NOT_FOUND while the owner's chat is archived,
        // locked or run by a computer, which can be undone, and the link stays bound to this browser's token. Only a view
        // read after this browser's own accepted post, which ignores the chat's state, says the link itself is gone.
        onError: async (error) => {
            // Another tab of this browser may hold the token the link is bound to: read storage again before the next try.
            if (errorCode(error) === "FORBIDDEN") {
                await rereadGuestToken(linkToken);
            }
        },
        onSuccess: (guestToken, note) => {
            pendingRef.current = undefined;
            void keepPendingPost(linkToken, undefined);
            setPostedAt(Date.now());
            // A draft typed while the post was on its way stays.
            setText((current) => (current.trim() === note.text ? "" : current));

            // Not awaited, so "Sending…" ends with the post. Only a fetch that worked and found nothing ends the link: a failed one
            // keeps the view from before the post, `null` for a new guest, and must not drop the token the post just bound.
            // A view still in flight began before the post (and, for a new guest, before this browser had a token): `refetch`
            // would reuse it while there is no data yet, so it is cancelled first and the view read anew.
            const settleLink = async (): Promise<void> => {
                // Cancelled at once, before any await: a view that began before the post must not land and read as "ended".
                const cancelled = queryClient.cancelQueries({ queryKey: ["guest-view", linkToken] });

                // The token this post was accepted with is kept before the view is read, whatever another tab wrote meanwhile:
                // a link found ended by that read then cannot have it written back after it was forgotten.
                await keepGuestToken(linkToken, guestToken);
                await cancelled;

                const result = await view.refetch();

                if (result.isSuccess && result.data === null) {
                    endLink();
                }
            };

            void settleLink();
        },
    });

    // A post whose reply was lost but which the notes now show as stored is done: its request id is let go, so the same words
    // sent again later are a new note, and a field still holding them (restored after a reload) is cleared.
    useEffect(() => {
        const pending = pendingRef.current;
        const stored =
            pending !== undefined && view.data?.messages.some((note) => note.text === pending.text && note.createdAt >= pending.at - 60_000) === true;

        if (!stored || post.isPending) {
            return;
        }

        pendingRef.current = undefined;
        void keepPendingPost(linkToken, undefined);
        setText((current) => (current.trim() === pending.text ? "" : current));
    }, [view.data, post.isPending, linkToken]);

    const linkEnded = ended || (postedAt !== undefined && view.isSuccess && view.data === null && view.dataUpdatedAt > postedAt);
    const endedByView = !ended && linkEnded;

    // A link found ended by a view (a poll after the post) forgets this browser's token, as one found ended by a post does.
    useEffect(() => {
        if (endedByView) {
            void forgetGuestToken(linkToken);
        }
    }, [endedByView, linkToken]);

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const trimmed = text.trim();

        if (trimmed === "") {
            return;
        }

        if (pendingRef.current?.text !== trimmed) {
            pendingRef.current = { at: Date.now(), requestId: globalThis.crypto.randomUUID(), text: trimmed };
        }

        post.mutate(pendingRef.current);
    };

    return (
        // `main-content`: where the layout's "Skip to content" link goes.
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4" id="main-content" tabIndex={-1}>
            {/* The card's title is the page's heading. */}
            <HeadingLevelProvider level={1}>
                <Card>
                    <CardHeader>
                        <CardTitle>{t`Leave a message`}</CardTitle>
                        <CardDescription>{t`Your message waits for the owner of this conversation. Nothing happens until they send it.`}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {LINK_TOKEN_SHAPE.test(linkToken) ? (
                            <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
                                <Label htmlFor={fieldId}>{t`Your message`}</Label>
                                <Textarea
                                    aria-describedby={post.isError && !linkEnded ? errorId : undefined}
                                    aria-invalid={post.isError && !linkEnded && errorCode(post.error) === "BAD_REQUEST" ? true : undefined}
                                    // `ph-no-capture`: a guest's words stay out of PostHog's autocapture and recordings.
                                    className="ph-no-capture"
                                    disabled={linkEnded}
                                    id={fieldId}
                                    maxLength={MAX_CHARS}
                                    onChange={(event) => setText(event.target.value)}
                                    required
                                    value={text}
                                />
                                {linkEnded && <p role="alert">{t`This link has ended.`}</p>}
                                {!linkEnded && post.isError && (
                                    <p className="ph-no-capture" id={errorId} role="alert">
                                        {errorMessage(post.error)}
                                    </p>
                                )}
                                {!linkEnded && view.isError && (
                                    <div className="flex flex-col items-start gap-2">
                                        <p role="alert">{t`Your notes could not be loaded. They are still there; try again in a moment.`}</p>
                                        <Button
                                            onClick={() => {
                                                view.refetch().catch(() => undefined);
                                            }}
                                            type="button"
                                            variant="outline"
                                        >
                                            {t`Try again`}
                                        </Button>
                                    </div>
                                )}
                                <Button disabled={!restored || linkEnded || post.isPending || text.trim() === ""} type="submit">
                                    {post.isPending ? t`Sending…` : t`Send to the owner`}
                                </Button>
                            </form>
                        ) : (
                            <p role="alert">{t`This link is not complete. Ask for the full link.`}</p>
                        )}
                    </CardContent>
                </Card>
            </HeadingLevelProvider>
            {/* Announced as it changes: a note that arrives, and one the owner sends on. */}
            <section aria-label={t`Your messages`} aria-live="polite" className="ph-no-capture flex flex-col gap-2">
                {view.isPending && view.fetchStatus === "fetching" && <p className="text-muted-foreground text-sm">{t`Loading your messages…`}</p>}
                {view.data?.messages.map((note) => (
                    <Card key={`${note.createdAt}:${note.text}`}>
                        <CardContent className="flex flex-col gap-2 pt-4">
                            <p className="text-sm break-words whitespace-pre-wrap">{note.text}</p>
                            <Badge variant={note.status === "held" ? "secondary" : "default"}>
                                {note.status === "held" ? t`Waiting for the owner` : t`Sent by the owner`}
                            </Badge>
                        </CardContent>
                    </Card>
                ))}
            </section>
        </main>
    );
};

/**
 * The page a guest link opens. The link token is read from the URL fragment only; the browser's own token is kept per link
 * (`guestTokenFor`). A guest can leave a note and see the notes they left, held until the owner sends them; nothing of the
 * thread is shown. Another link opened in the same tab starts afresh (keyed by its token).
 */
const GuestPage: FC = () => {
    const hash = useSyncExternalStore(subscribeToHash, readHash, noHashOnServer);
    // The last link token this page read: an in-page anchor (the "Skip to content" link's `#main-content`) is no link.
    const [lastLinkToken, setLastLinkToken] = useState<string>();

    if (hash !== undefined && LINK_TOKEN_SHAPE.test(hash) && hash !== lastLinkToken) {
        setLastLinkToken(hash);
    }

    // Only the layout's own in-page anchor keeps the link; any other fragment is a link of its own, shown as incomplete if it
    // is not one, never sent to the link opened before it.
    const keepsLastLink = hash === SKIP_LINK_ANCHOR && lastLinkToken !== undefined;
    const linkToken = keepsLastLink ? lastLinkToken : hash;

    // An in-page anchor took the link out of the address: put it back, so a reload or a copied address still opens the link.
    useEffect(() => {
        if (hash !== SKIP_LINK_ANCHOR || lastLinkToken === undefined) {
            return;
        }

        globalThis.history.replaceState(globalThis.history.state, "", `#${lastLinkToken}`);
        // `replaceState` fires no `hashchange`: without one, a second click on the same anchor would leave it in the address.
        globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
    }, [hash, lastLinkToken]);

    return linkToken === undefined ? null : <GuestLinkPage key={linkToken} linkToken={linkToken} />;
};

export default GuestPage;
