"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FlaskConical } from "lucide-react";
import type { FC } from "react";
import { use, useId, useState } from "react";
import { toast } from "sonner";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { ChatMessagesContext } from "@/features/chat/core/context/chat-context";
import type { UIMessage } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";

import type { CaseFormValues } from "../lib/evals-format";
import { EMPTY_CASE, formToCasePayload } from "../lib/evals-format";
import CaseFields from "./case-fields";

/** The user prompt an assistant message answered: the nearest user message before it. */
const findPrompt = (messages: ReadonlyArray<UIMessage>, messageId: string): string => {
    const index = messages.findIndex((message) => message.id === messageId);

    for (let position = index - 1; position >= 0; position -= 1) {
        const candidate = messages[position];

        if (candidate?.role === "user") {
            return getVisibleUserText(candidate);
        }
    }

    return "";
};

const SaveEvalCaseBody = ({ message, onClose }: { message: UIMessage; onClose: () => void }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const baseId = useId();
    // Read once when the dialog opens — the action bar itself stays off the messages context.
    const messagesContext = use(ChatMessagesContext);
    const { data: datasets = [], isLoading } = useQuery(crpc.evals.functions.listDatasets.queryOptions({}));
    const createCase = useMutation(crpc.evals.functions.createCase.mutationOptions());
    const [datasetId, setDatasetId] = useState<Id<"evalDatasets"> | null>(null);
    const [values, setValues] = useState<CaseFormValues>(() => {
        return {
            ...EMPTY_CASE,
            expectedAnswer: getVisibleUserText(message),
            input: findPrompt(messagesContext?.messages ?? [], message.id),
        };
    });
    const [submitted, setSubmitted] = useState(false);
    const chosen = datasets.find((dataset) => dataset._id === datasetId) ?? datasets[0];

    const handleSubmit = async () => {
        setSubmitted(true);

        if (!chosen || !values.input.trim()) {
            return;
        }

        try {
            await createCase.mutateAsync({ ...formToCasePayload(values), datasetId: chosen._id, source: "chat" });
            toast.success(t`Saved to "${chosen.name}"`);
            onClose();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to save the case`);
        }
    };

    return (
        <DialogContent className="max-w-2xl">
            <DialogHeader>
                <DialogTitle>{t`Save as eval case`}</DialogTitle>
                <DialogDescription>{t`The prompt becomes the case input and this answer the expected answer. Edit either before saving.`}</DialogDescription>
            </DialogHeader>
            {!isLoading && datasets.length === 0 ? (
                <>
                    <DialogPanel>
                        <p className="text-sm">
                            {t`You have no eval datasets yet.`}{" "}
                            <Link className="text-primary underline-offset-4 hover:underline" to="/evals">
                                {t`Create one on the Evals page.`}
                            </Link>
                        </p>
                    </DialogPanel>
                    <DialogFooter>
                        <Button onClick={onClose} type="button" variant="outline">
                            {t`Close`}
                        </Button>
                    </DialogFooter>
                </>
            ) : (
                <form
                    autoComplete="off"
                    className="contents"
                    noValidate
                    onSubmit={(event) => {
                        event.preventDefault();
                        void handleSubmit();
                    }}
                >
                    <DialogPanel>
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label id={`${baseId}-dataset`}>{t`Dataset`}</Label>
                                <Select
                                    items={datasets.map((dataset) => {
                                        return { label: dataset.name, value: dataset._id };
                                    })}
                                    onValueChange={(value) => setDatasetId((value ?? null) as Id<"evalDatasets"> | null)}
                                    value={chosen?._id ?? null}
                                >
                                    <SelectTrigger aria-labelledby={`${baseId}-dataset`}>
                                        <SelectValue placeholder={t`Pick a dataset`} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {datasets.map((dataset) => (
                                            <SelectItem key={dataset._id} value={dataset._id}>
                                                {dataset.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <CaseFields rag={chosen?.kind === "rag"} setValues={setValues} showErrors={submitted} values={values} />
                        </div>
                    </DialogPanel>
                    <DialogFooter>
                        <Button onClick={onClose} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button aria-busy={createCase.isPending} disabled={createCase.isPending || !chosen} type="submit">
                            {t`Save case`}
                        </Button>
                    </DialogFooter>
                </form>
            )}
        </DialogContent>
    );
};

/** The "Save as eval case" action on an assistant message: its prompt and answer become a case in one of the user's datasets. */
const SaveEvalCaseAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();
    const { isAnonymous } = useIsAnonymous();
    const [open, setOpen] = useState(false);

    // Evals need an account; an anonymous user could not own a dataset to save into.
    if (isAnonymous) {
        return null;
    }

    return (
        <>
            <MessageAction onClick={() => setOpen(true)} tooltip={t`Save as eval case`}>
                <FlaskConical aria-hidden className="size-4" />
            </MessageAction>
            <Dialog onOpenChange={setOpen} open={open}>
                {open && <SaveEvalCaseBody message={message} onClose={() => setOpen(false)} />}
            </Dialog>
        </>
    );
};

export default SaveEvalCaseAction;
