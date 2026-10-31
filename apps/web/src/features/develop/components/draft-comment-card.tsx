"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { useState } from "react";

import CommentComposer from "./comment-composer";

/** A comment in the draft, posted with the rest of the review on submit. Editable until then. */
const DraftCommentCard = ({
    body,
    locked,
    onDelete,
    onEdit,
}: {
    body: string;
    locked: boolean;
    onDelete: () => Promise<string | null>;
    onEdit: (body: string) => Promise<string | null>;
}) => {
    const { t } = useLingui();
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="bg-background text-foreground sticky left-0 my-1 max-w-3xl space-y-2 rounded-md border border-dashed p-3 font-sans text-sm whitespace-normal">
            <Badge variant="outline">{t`Pending: posted when you submit the review`}</Badge>
            {editing ? (
                <CommentComposer
                    initial={body}
                    label={t`Edit comment`}
                    onCancel={() => setEditing(false)}
                    onSubmit={async (next) => {
                        const failure = await onEdit(next);

                        if (failure === null) {
                            setEditing(false);
                        }

                        return failure;
                    }}
                    submitLabel={t`Save`}
                />
            ) : (
                <>
                    <p className="break-words whitespace-pre-wrap">{body}</p>
                    {!locked && (
                        <div className="flex gap-2">
                            <Button onClick={() => setEditing(true)} size="sm" variant="outline">
                                {t`Edit`}
                            </Button>
                            <Button
                                onClick={async () => {
                                    setError(await onDelete());
                                }}
                                size="sm"
                                variant="ghost"
                            >
                                {t`Delete`}
                            </Button>
                        </div>
                    )}
                </>
            )}
            {error !== null && (
                <p className="text-destructive text-xs" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
};

export default DraftCommentCard;
