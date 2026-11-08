import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Label } from "@neore/ui/components/label";
import { Textarea } from "@neore/ui/components/textarea";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import type { FC, FormEvent } from "react";
import { useId, useRef, useState, useSyncExternalStore } from "react";

import { useAction } from "@/lib/lunora/crpc";

import { guestPollInterval } from "./guest-poll";
import { forgetGuestToken, guestTokenFor } from "./guest-token";

/** A guest note's cap (`GUEST_MESSAGE_MAX_CHARS` in the backend). */
const MAX_CHARS = 2000;

/** The URL fragment, the only place a guest link carries its token; `undefined` on the server, where there is none. */
const subscribeToHash = (onChange: () => void): (() => void) => {
    globalThis.addEventListener("hashchange", onChange);

    return () => globalThis.removeEventListener("hashchange", onChange);
};
const readHash = (): string => globalThis.location.hash.slice(1);
const noHashOnServer = (): undefined => undefined;

/** The backend's error code (`LunoraError#code`), wherever the client put it. */
const errorCode = (error: unknown): unknown => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return data?.code ?? code;
};

/**
 * The page a guest link opens. The link token is read from the URL fragment only; the browser's own token is kept per link
 * (`guestTokenFor`). A guest can leave a note and see the notes they left, held until the owner sends them; nothing of the
 * thread is shown.
 */
const GuestPage: FC = () => {
    const { t } = useLingui();
    const fieldId = useId();
    const linkToken = useSyncExternalStore(subscribeToHash, readHash, noHashOnServer);
    const [text, setText] = useState("");
    // When the last post went through: a view fetched after it that answers nothing means the link has ended. A view from
    // before it (nothing left yet, for a new guest) says nothing about the link.
    const [postedAt, setPostedAt] = useState<number>();
    const [ended, setEnded] = useState(false);
    // A post that failed keeps its request id, so sending the same text again cannot store it twice.
    const pendingRef = useRef<{ requestId: string; text: string } | undefined>(undefined);
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
                return t`This link has ended.`;
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
        mutationFn: async (note: { requestId: string; text: string }) =>
            await postNote({ guestToken: await guestTokenFor(linkToken ?? "", { create: true }), linkToken: linkToken ?? "", ...note }),
        onError: (error) => {
            if (errorCode(error) === "NOT_FOUND") {
                endLink();
            }
        },
        onSuccess: () => {
            pendingRef.current = undefined;
            setPostedAt(Date.now());
            setText("");

            // Not awaited, so "Sending…" ends with the post. Only a fetch that worked and found nothing ends the link: a failed one
            // keeps the view from before the post, `null` for a new guest, and must not drop the token the post just bound.
            const settleLink = async (): Promise<void> => {
                const result = await view.refetch();

                if (result.isSuccess && result.data === null) {
                    endLink();
                }
            };

            void settleLink();
        },
    });

    if (linkToken === undefined) {
        return null;
    }

    const linkEnded = ended || (postedAt !== undefined && view.isSuccess && view.data === null && view.dataUpdatedAt > postedAt);

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const trimmed = text.trim();

        if (trimmed === "") {
            return;
        }

        if (pendingRef.current?.text !== trimmed) {
            pendingRef.current = { requestId: globalThis.crypto.randomUUID(), text: trimmed };
        }

        post.mutate(pendingRef.current);
    };

    return (
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4">
            <Card>
                <CardHeader>
                    <CardTitle>{t`Leave a message`}</CardTitle>
                    <CardDescription>{t`Your message waits for the owner of this conversation. Nothing happens until they send it.`}</CardDescription>
                </CardHeader>
                <CardContent>
                    {linkToken === "" ? (
                        <p role="alert">{t`This link is not complete. Ask for the full link.`}</p>
                    ) : (
                        <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
                            <Label htmlFor={fieldId}>{t`Your message`}</Label>
                            <Textarea
                                disabled={linkEnded}
                                id={fieldId}
                                maxLength={MAX_CHARS}
                                onChange={(event) => setText(event.target.value)}
                                required
                                value={text}
                            />
                            {linkEnded && <p role="alert">{t`This link has ended.`}</p>}
                            {!linkEnded && post.isError && <p role="alert">{errorMessage(post.error)}</p>}
                            {!linkEnded && view.isError && (
                                <p role="alert">{t`Your notes could not be loaded. They are still there; try again in a moment.`}</p>
                            )}
                            <Button disabled={linkEnded || post.isPending || text.trim() === ""} type="submit">
                                {post.isPending ? t`Sending…` : t`Send to the owner`}
                            </Button>
                        </form>
                    )}
                </CardContent>
            </Card>
            {/* Announced as it changes: a note that arrives, and one the owner sends on. */}
            <section aria-label={t`Your messages`} aria-live="polite" className="flex flex-col gap-2">
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

export default GuestPage;
