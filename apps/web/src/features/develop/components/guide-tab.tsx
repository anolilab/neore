"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Textarea } from "@neore/ui/components/textarea";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";

import type { HostOffer } from "../lib/guide";
import { hostOffersFor, offerKey } from "../lib/guide";
import type { PullRequestAddress } from "../lib/use-develop";
import { useGuide, useGuideActions, useGuideDevices, useNow } from "../lib/use-guide";
import { GuideProposals, GuideStops } from "./guide-view";

const CLOUD = "cloud";

type Notice = { kind: "error" | "info"; text: string };

/**
 * The guide of one change request: the person's instructions, where it is written (our own agent from the diff, or a
 * coding agent on one of their computers), and the guide itself in reading order. A guide is about one head commit;
 * once the change request has another it is shown as out of date with a way to write it again.
 */
const GuideTab = ({
    address,
    headSha,
    hostLabel,
    onOpenFile,
    requestNoun,
}: {
    address: PullRequestAddress;
    headSha: string;
    hostLabel: string;
    onOpenFile: (path: string) => void;
    requestNoun: string;
}) => {
    const { t } = useLingui();
    const instructionsId = useId();
    const guide = useGuide(address, headSha, true);
    const devices = useGuideDevices(true);
    const now = useNow();
    const actions = useGuideActions(address);
    // What is being typed, or `null` while the box shows the instructions the shown guide was written under.
    const [typed, setTyped] = useState<string | null>(null);
    const [target, setTarget] = useState<string>(CLOUD);
    const [notice, setNotice] = useState<Notice | null>(null);
    const offers = useMemo(() => hostOffersFor(devices.data ?? [], address.repository, now), [address.repository, devices.data, now]);

    if (guide.isPending) {
        return <Skeleton aria-label={t`Loading the guide`} className="h-24 w-full" role="status" />;
    }

    const chosen: HostOffer | undefined = offers.find((offer) => offerKey(offer) === target);

    const failureText: Record<string, string> = {
        abandoned: t`The guide did not finish. Write it again.`,
        head_moved: t`The ${requestNoun} changed while the guide was being written. Write it again.`,
        host_error: t`${hostLabel} or your computer could not be reached while the guide was written.`,
        model_error: t`The guide could not be written. Try again in a moment.`,
        no_answer: t`The agent finished without giving a guide. Write it again.`,
        not_connected: t`${hostLabel} is not connected.`,
        quota: t`Your daily limit for AI requests is used up.`,
        too_large: t`This change is too large to write a guide for.`,
    };

    const found = guide.data;
    const current = found?.guide;
    const generating = current?.status === "generating";
    const stale = found?.freshness === "stale";
    const instructions = typed ?? current?.instructions ?? "";
    const pending = actions.generate.isPending || actions.startHost.isPending || generating;

    const write = async (): Promise<void> => {
        setNotice(null);

        try {
            const outcome =
                chosen === undefined
                    ? await actions.generate.mutateAsync({ instructions })
                    : await actions.startHost.mutateAsync({ agentKey: chosen.agentKey, deviceId: chosen.deviceId, folderId: chosen.folderId, instructions });

            const rateLimited = t`Too many requests. Try again in a few minutes.`;
            const tooLarge = t`This change, or your instructions, are too large for that computer to take in one message.`;
            const refusals: Record<string, string> = {
                folder_mismatch: t`That folder is not offered for this repository on that computer.`,
                forbidden: t`${hostLabel} refused this request.`,
                guest: t`Sign in to an account to write a guide.`,
                host_error: t`${hostLabel} could not be reached. Try again in a moment.`,
                needs_reconnect: t`Your ${hostLabel} sign-in has expired. Connect it again.`,
                not_connected: t`${hostLabel} is not connected.`,
                not_found: t`It does not exist, or your ${hostLabel} account cannot see it.`,
                quota: t`Your daily limit for AI requests is used up.`,
                rate_limited: rateLimited,
                running: t`A guide for this ${requestNoun} is already being written.`,
                too_large: tooLarge,
            };
            const unavailable = {
                busy: t`That computer is busy. Try again in a moment.`,
                offline: t`That computer is not online.`,
                rate_limited: rateLimited,
                session_ended: t`That agent session has ended.`,
                too_large: tooLarge,
            };

            if (outcome.status === "started") {
                setTyped(null);
            } else if (outcome.status === "unavailable") {
                setNotice({ kind: "error", text: unavailable[outcome.reason] });
            } else {
                setNotice({ kind: "error", text: refusals[outcome.status] ?? t`The guide could not be started.` });
            }
        } catch {
            setNotice({ kind: "error", text: t`The guide could not be started.` });
        }
    };

    const proposalOutcome = async (run: () => Promise<{ status: string }>): Promise<void> => {
        setNotice(null);

        const texts: Record<string, Notice> = {
            applied: { kind: "info", text: t`Added to your review. Nothing is posted until you submit the review.` },
            head_moved: { kind: "error", text: t`The ${requestNoun} has a newer commit. Write the guide again before adding its comments.` },
            not_found: { kind: "error", text: t`That suggestion is gone.` },
            not_ready: { kind: "error", text: t`That suggestion cannot be added any more.` },
            submitting: { kind: "error", text: t`Your review is being submitted. Try again when it is done.` },
            too_many: { kind: "error", text: t`Your review already holds as many comments as ${hostLabel} takes in one review.` },
        };

        try {
            const outcome = await run();
            const text = texts[outcome.status];

            if (text !== undefined) {
                setNotice(text);
            }
        } catch {
            setNotice({ kind: "error", text: t`That did not work. Try again.` });
        }
    };

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <label className="text-sm" htmlFor={instructionsId}>
                    {t`What should the guide pay attention to?`}
                </label>
                <Textarea
                    disabled={pending}
                    id={instructionsId}
                    maxLength={5000}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder={t`For example: look hard at error handling, skip the generated files.`}
                    value={instructions}
                />
                {offers.length > 0 && (
                    <RadioGroup
                        aria-label={t`Where the guide is written`}
                        className="space-y-1"
                        disabled={pending}
                        onValueChange={(value) => setTarget(String(value))}
                        value={target}
                    >
                        <div className="flex items-center gap-2 text-sm">
                            <RadioGroupItem id={`${instructionsId}-cloud`} value={CLOUD} />
                            <label htmlFor={`${instructionsId}-cloud`}>{t`Neore, from the diff`}</label>
                        </div>
                        {offers.map((offer) => (
                            <div className="flex items-center gap-2 text-sm" key={offerKey(offer)}>
                                <RadioGroupItem id={`${instructionsId}-${offerKey(offer)}`} value={offerKey(offer)} />
                                <label
                                    htmlFor={`${instructionsId}-${offerKey(offer)}`}
                                >{t`${offer.agentLabel} on ${offer.deviceName}, in ${offer.folderLabel}`}</label>
                            </div>
                        ))}
                    </RadioGroup>
                )}
                <Button disabled={pending} onClick={write} type="button">
                    {current === undefined ? t`Write the guide` : t`Write it again`}
                </Button>
            </div>
            {notice !== null && (
                <p className={notice.kind === "error" ? "text-destructive text-sm" : "text-sm"} role={notice.kind === "error" ? "alert" : "status"}>
                    {notice.text}
                </p>
            )}
            {generating && (
                <p className="text-muted-foreground text-sm" role="status">
                    {current.source === "host" ? t`The agent on your computer is reading the change…` : t`Writing the guide…`}
                    {current.source === "host" && current.threadId !== undefined && (
                        <>
                            {" "}
                            <Link className="text-primary underline" params={{ threadId: current.threadId }} to="/chat/$threadId">
                                {t`Open the agent's conversation`}
                            </Link>
                        </>
                    )}
                </p>
            )}
            {current?.status === "failed" && (
                <Alert variant="destructive">
                    <AlertTitle>{t`No guide`}</AlertTitle>
                    <AlertDescription>{failureText[current.failure ?? "abandoned"]}</AlertDescription>
                </Alert>
            )}
            {current?.status === "ready" && (
                <>
                    {stale && (
                        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="status">
                            {t`This guide was written for an earlier commit. The ${requestNoun} has changed since: write it again to see the change as it is now.`}
                        </p>
                    )}
                    {current.summary !== "" && <p className="text-sm break-words whitespace-pre-wrap">{current.summary}</p>}
                    {current.leftOut > 0 && (
                        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
                            {t`${hostLabel} lists only part of this change; ${current.leftOut} files are not in the guide.`}
                        </p>
                    )}
                    <GuideStops onOpenFile={onOpenFile} stops={current.stops} />
                    {current.proposals.length > 0 && (
                        <section aria-labelledby={`${instructionsId}-suggestions`} className="space-y-2">
                            <h3 className="text-sm font-medium" id={`${instructionsId}-suggestions`}>
                                {t`Suggestions`}
                            </h3>
                            <GuideProposals
                                busy={actions.apply.isPending || actions.dismiss.isPending || stale}
                                hostLabel={hostLabel}
                                onApply={async (proposalId) =>
                                    await proposalOutcome(
                                        async () => await actions.apply.mutateAsync({ guideId: current.id as Id<"pullRequestGuides">, headSha, proposalId }),
                                    )
                                }
                                onDismiss={async (proposalId) =>
                                    await proposalOutcome(
                                        async () => await actions.dismiss.mutateAsync({ guideId: current.id as Id<"pullRequestGuides">, proposalId }),
                                    )
                                }
                                proposals={current.proposals}
                            />
                        </section>
                    )}
                </>
            )}
        </div>
    );
};

export default GuideTab;
