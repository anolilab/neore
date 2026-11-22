"use client";

import { useLingui } from "@lingui/react/macro";
import { GOAL_TEXT_MAX } from "@neore/backend/chat/goals";
import { useUnlockProof } from "@neore/client-runtime";
import { Button } from "@neore/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/popover";
import { Textarea } from "@neore/ui/components/textarea";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Pin, X } from "lucide-react";
import type { FC, FormEvent } from "react";
import { useEffect, useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { setPinOverride, useGoalComposer } from "./goal-store";

interface PinnedGoalProps {
    disabled?: boolean;
    threadId: string;
}

/**
 * The chat's pinned goal: every message the owner sends here runs it until it is cleared or replaced. A goal armed for one
 * message (the Goal control) overrides it for that message. Shown to the owner only, as the other owner controls are.
 */
const PinnedGoal: FC<PinnedGoalProps> = ({ disabled, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const unlockProof = useUnlockProof(threadId);
    const maxRounds = useGoalComposer((state) => state.maxRounds);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const fieldId = useId();

    const { data: access } = useQuery(crpc.chat.sharing.getThreadAccess.queryOptions({ threadId: threadId as never, unlockProof }));
    const isOwner = access?.isOwner === true;
    const { data: pinned } = useQuery(crpc.chat.goals.functions.getPinnedGoal.queryOptions(isOwner ? { threadId: threadId as never, unlockProof } : skipToken));

    // The live query has caught up with the server: its own value supersedes what this tab saved.
    useEffect(() => {
        setPinOverride(threadId, undefined);
    }, [pinned, threadId]);

    const pin = useMutation(
        crpc.chat.goals.functions.setPinnedGoal.mutationOptions({
            onSuccess: (_data, variables) => {
                setPinOverride(variables.threadId, { maxRounds: variables.maxRounds, text: variables.text });
                setOpen(false);
            },
        }),
    );
    const clear = useMutation(
        crpc.chat.goals.functions.clearPinnedGoal.mutationOptions({
            onSuccess: (_data, variables) => {
                setPinOverride(variables.threadId, null);
            },
        }),
    );

    if (!isOwner) {
        return null;
    }

    const handleOpenChange = (next: boolean) => {
        if (next) {
            setDraft(pinned?.text ?? "");
        }

        setOpen(next);
    };

    // The pin keeps the review rounds the composer shows now: a later change to the rounds applies to the next pin.
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const text = draft.trim();

        if (text.length > 0) {
            pin.mutate({ maxRounds, text, threadId: threadId as never, unlockProof });
        }
    };

    return (
        <div className="flex items-center gap-1">
            <Popover onOpenChange={handleOpenChange} open={open}>
                <PopoverTrigger
                    render={
                        pinned ? (
                            <Button
                                aria-label={t`Change the pinned goal: ${pinned.text}`}
                                className="bg-primary/10 text-primary-text border-primary/30 hover:bg-primary/20 h-7 max-w-48 gap-1 px-2"
                                disabled={disabled}
                                variant="outline"
                            >
                                <Pin aria-hidden="true" className="size-3 shrink-0" />
                                <span className="truncate">{pinned.text}</span>
                            </Button>
                        ) : (
                            <Button
                                aria-label={t`Pin goal`}
                                className="bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 text-foreground h-7 gap-1 px-2 dark:text-white"
                                disabled={disabled}
                                variant="outline"
                            >
                                <Pin aria-hidden="true" className="size-3 shrink-0" />
                                <span className="hidden text-neutral-700 sm:inline dark:text-neutral-200">{t`Pin goal`}</span>
                            </Button>
                        )
                    }
                />
                <PopoverContent className="w-80 p-3">
                    <form className="flex flex-col gap-2" onSubmit={submit}>
                        <label className="text-sm font-medium" htmlFor={fieldId}>
                            {t`Goal for this chat`}
                        </label>
                        <Textarea
                            id={fieldId}
                            maxLength={GOAL_TEXT_MAX}
                            onChange={(event) => {
                                setDraft(event.target.value);
                            }}
                            rows={3}
                            value={draft}
                        />
                        <p className="text-muted-foreground text-xs">{t`Runs for every message you send here, up to ${maxRounds} review rounds each, until you clear it.`}</p>
                        <div className="flex justify-end">
                            <Button disabled={disabled || draft.trim().length === 0 || pin.isPending} type="submit">
                                {t`Save`}
                            </Button>
                        </div>
                    </form>
                </PopoverContent>
            </Popover>
            {pinned && (
                <Button
                    aria-label={t`Clear pinned goal`}
                    className="h-7 px-1.5"
                    disabled={disabled || clear.isPending}
                    onClick={() => {
                        clear.mutate({ threadId: threadId as never, unlockProof });
                    }}
                    variant="outline"
                >
                    <X aria-hidden="true" className="size-3" />
                </Button>
            )}
        </div>
    );
};

export default PinnedGoal;
