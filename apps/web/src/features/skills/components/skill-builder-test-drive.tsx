"use client";

import { useLingui } from "@lingui/react/macro";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { ExternalLink, FlaskConical, Loader2 } from "lucide-react";
import { useId, useState } from "react";

import { useCRPCClient } from "@/lib/lunora/crpc";

import type { BuilderAcceptance, BuilderDraft } from "../lib/skill-builder";
import { toSkillConfig } from "../lib/skill-builder";

interface SkillBuilderTestDriveProps {
    acceptance: BuilderAcceptance;
    draft: BuilderDraft;
}

/**
 * Runs the unsaved draft in a temporary chat — the builder's "test drive". The thread comes
 * from the ordinary `createThread({ temporary: true })`, so it expires and is
 * deleted like any temporary chat; the draft rides on it server-side and runs
 * through the normal chat pipeline — tool permissions, including "ask" tools'
 * approval prompts, apply exactly as they would for a saved skill.
 */
const SkillBuilderTestDrive = ({ acceptance, draft }: SkillBuilderTestDriveProps) => {
    const { t } = useLingui();
    const id = useId();
    const crpcClient = useCRPCClient();
    const [values, setValues] = useState<Record<string, string>>({});
    const [isStarting, setIsStarting] = useState(false);
    const [status, setStatus] = useState<{ kind: "error" | "success"; message: string; threadId?: string } | null>(null);

    const start = async () => {
        if (isStarting) {
            return;
        }

        setIsStarting(true);
        setStatus(null);

        // Opened synchronously, inside the click, so the browser does not block it
        // as a popup; pointed at the thread once it exists.
        const tab = globalThis.open("about:blank", "_blank");

        try {
            const config = toSkillConfig(draft, acceptance);
            const threadId = await crpcClient.mutation(api.chat.functions.createThread, {
                model: config.preferredModel ?? DEFAULT_CHAT_MODEL,
                temporary: true,
                title: t`Test drive: ${draft.name}`,
            });

            await crpcClient.mutation(api.skills.builder.attachSkillTestDrive, {
                config,
                instructions: draft.instructions,
                name: draft.name,
                threadId: threadId as Id<"threads">,
                variableValues: values,
                variables: draft.variables.map((variable) => {
                    return { ...(variable.defaultValue && { defaultValue: variable.defaultValue }), name: variable.name };
                }),
            });

            const url = `/chat/${threadId}`;

            if (tab) {
                tab.opener = null;
                tab.location.href = url;
            }

            setStatus({ kind: "success", message: t`Test drive ready in a temporary chat. It is deleted automatically.`, threadId });
        } catch (error) {
            tab?.close();
            setStatus({ kind: "error", message: error instanceof Error && error.message ? error.message : t`Could not start the test drive.` });
        } finally {
            setIsStarting(false);
        }
    };

    return (
        <section aria-labelledby={`${id}-heading`} className="bg-muted/40 space-y-3 rounded-lg border p-4">
            <div className="space-y-1">
                <h3 className="flex items-center gap-2 text-sm font-medium" id={`${id}-heading`}>
                    <FlaskConical aria-hidden="true" className="size-4" />
                    {t`Test drive`}
                </h3>
                <p className="text-muted-foreground text-xs">
                    {t`Try the draft with the settings you accepted, without saving it. Opens a temporary chat in a new tab.`}
                </p>
            </div>
            {draft.variables.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                    {draft.variables.map((variable) => (
                        <div className="space-y-1" key={variable.name}>
                            <Label className="font-mono text-xs" htmlFor={`${id}-${variable.name}`}>
                                {variable.name}
                            </Label>
                            <Input
                                id={`${id}-${variable.name}`}
                                onChange={(event) =>
                                    setValues((previous) => {
                                        return { ...previous, [variable.name]: event.target.value };
                                    })
                                }
                                placeholder={variable.defaultValue ?? variable.description}
                                value={values[variable.name] ?? ""}
                            />
                        </div>
                    ))}
                </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p aria-live="polite" className={status?.kind === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"} role="status">
                    {isStarting ? t`Starting test drive…` : status?.message}
                    {status?.threadId && (
                        <>
                            {" "}
                            <a className="inline-flex items-center gap-1 underline" href={`/chat/${status.threadId}`} rel="noopener noreferrer" target="_blank">
                                {t`Open it again`}
                                <ExternalLink aria-hidden="true" className="size-3" />
                            </a>
                        </>
                    )}
                </p>
                <Button aria-busy={isStarting} disabled={isStarting || !draft.instructions.trim()} onClick={start} size="sm" type="button" variant="secondary">
                    {isStarting ? (
                        <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
                    ) : (
                        <FlaskConical aria-hidden="true" className="mr-2 size-4" />
                    )}
                    {t`Start test drive`}
                </Button>
            </div>
        </section>
    );
};

export default SkillBuilderTestDrive;
