"use client";

/**
 * "Forward" dialog: pick a skill (or none) and an optional note, then open a
 * NEW chat whose first message quotes the selected messages.
 *
 * The new chat is started through the same hand-off the home page, landing
 * page and onboarding use (`LANDING_MESSAGE_KEY` → `/chat?initialMessage=true`):
 * the composer opens pre-filled with `/<skill> <note>` and the quotes, and the
 * chat — with that skill active — is created by the ordinary send, on the
 * caller's own shard. See `build-forward-text.ts` for why the quotes need no
 * server-side check.
 *
 * Code-split: loaded only when "Forward" is pressed.
 */
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Textarea } from "@neore/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { FC, FormEvent } from "react";
import { useId, useState } from "react";

import { LANDING_MESSAGE_KEY } from "@/features/marketing/stores/landing-store";
import { useAction } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import type { ForwardableMessage } from "./build-forward-text";
import { buildForwardText } from "./build-forward-text";

/** The radio value for "no skill". Not a valid slug, so it cannot collide with one. */
const NO_SKILL = "__none__";

const MAX_NOTE_CHARS = 2000;

interface ForwardDialogProps {
    messages: ReadonlyArray<ForwardableMessage>;
    /** Called once the new chat is on its way; the caller ends select mode. */
    onDone: () => void;
    onOpenChange: (open: boolean) => void;
}

const matchesFilter = (skill: Doc<"skills">, filter: string): boolean => {
    if (!filter) {
        return true;
    }

    const needle = filter.toLowerCase();

    return skill.name.toLowerCase().includes(needle) || skill.slug.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle);
};

const ForwardDialog: FC<ForwardDialogProps> = ({ messages, onDone, onOpenChange }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const getSkills = useAction(api.skills.functions.getSkills);
    const noteId = useId();
    const filterId = useId();
    const skillsLabelId = useId();
    const [skillSlug, setSkillSlug] = useState(NO_SKILL);
    const [note, setNote] = useState("");
    const [filter, setFilter] = useState("");

    // The same list the composer's "/" skill menu offers.
    const {
        data: skills,
        isError,
        isPending,
    } = useQuery({
        queryFn: async () => await getSkills({ sortBy: "recent" }),
        queryKey: ["forward-dialog", "skills"],
        staleTime: 60_000,
    });

    const visibleSkills = (skills ?? []).filter((skill) => matchesFilter(skill, filter.trim()));

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();

        const text = buildForwardText(messages, {
            note,
            skillSlug: skillSlug === NO_SKILL ? undefined : skillSlug,
            truncatedNotice: t`The forwarded messages were shortened to fit.`,
        });

        try {
            sessionStorage.setItem(LANDING_MESSAGE_KEY, text);
        } catch {
            showError(t`Could not prepare the new chat. Copy the messages instead.`);

            return;
        }

        onDone();
        await navigate({ search: { initialMessage: true }, to: "/chat" });
    };

    return (
        <Dialog onOpenChange={onOpenChange} open>
            <DialogContent className="sm:max-w-lg">
                <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>{t`Forward to a new chat`}</DialogTitle>
                        <DialogDescription>{t`A new chat opens with the selected messages quoted. Review it, then send.`}</DialogDescription>
                    </DialogHeader>
                    <DialogPanel className="flex flex-col gap-5">
                        <div aria-labelledby={skillsLabelId} role="group">
                            <p className="mb-2 text-sm font-medium" id={skillsLabelId}>
                                {t`Skill`}
                            </p>
                            {(skills?.length ?? 0) > 6 && (
                                <div className="mb-2">
                                    <label className="sr-only" htmlFor={filterId}>
                                        {t`Filter skills`}
                                    </label>
                                    <Input id={filterId} onChange={(event) => setFilter(event.target.value)} placeholder={t`Filter skills`} value={filter} />
                                </div>
                            )}
                            {isPending && (
                                <p className="text-muted-foreground text-sm" role="status">
                                    {t`Loading skills…`}
                                </p>
                            )}
                            {isError && <p className="text-muted-foreground text-sm">{t`Skills could not be loaded. You can still forward without one.`}</p>}
                            <RadioGroup
                                className="flex max-h-64 flex-col gap-2 overflow-y-auto"
                                onValueChange={(value) => setSkillSlug(String(value))}
                                value={skillSlug}
                            >
                                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input */}
                                <label className="flex cursor-pointer items-start gap-2 text-sm">
                                    <RadioGroupItem className="mt-0.5" value={NO_SKILL} />
                                    <span className="font-medium">{t`No skill`}</span>
                                </label>
                                {visibleSkills.map((skill) => (
                                    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input
                                    <label className="flex cursor-pointer items-start gap-2 text-sm" key={skill._id}>
                                        <RadioGroupItem className="mt-0.5" value={skill.slug} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block font-medium">{skill.name}</span>
                                            <span className="text-muted-foreground line-clamp-2 block text-xs">{skill.description}</span>
                                        </span>
                                    </label>
                                ))}
                            </RadioGroup>
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium" htmlFor={noteId}>
                                {t`Note (optional)`}
                            </label>
                            <Textarea
                                className="min-h-20"
                                id={noteId}
                                maxLength={MAX_NOTE_CHARS}
                                onChange={(event) => setNote(event.target.value)}
                                placeholder={t`What should happen with these messages?`}
                                value={note}
                            />
                        </div>
                    </DialogPanel>
                    <DialogFooter>
                        <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={messages.length === 0} type="submit">
                            {t`Open new chat`}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default ForwardDialog;
