"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import type { FC, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { MAX_COMMENT_CHARS } from "./diff-comments";

interface DiffCommentFormProps {
    /** Names the box for assistive technology: the file and lines the comment is on. */
    label: string;
    onCancel: () => void;
    onSubmit: (text: string) => void;
}

/** A comment box for one place in a diff. Takes focus when it opens; Escape closes it, Ctrl or Cmd with Enter adds. */
const DiffCommentForm: FC<DiffCommentFormProps> = ({ label, onCancel, onSubmit }) => {
    const { t } = useLingui();
    const [text, setText] = useState("");
    const field = useRef<HTMLTextAreaElement>(null);
    const trimmed = text.trim();

    useEffect(() => {
        field.current?.focus();
    }, []);

    const submit = () => {
        if (trimmed !== "") {
            onSubmit(trimmed);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
        }
    };

    return (
        <form
            className="flex flex-col gap-2 p-2"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <textarea
                aria-label={label}
                className="bg-background min-h-16 w-full resize-y rounded-md border px-2 py-1 text-sm"
                maxLength={MAX_COMMENT_CHARS}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t`What should the agent change?`}
                ref={field}
                value={text}
            />
            <div className="flex gap-2">
                <Button disabled={trimmed === ""} size="sm" type="submit">
                    <Trans>Add comment</Trans>
                </Button>
                <Button onClick={onCancel} size="sm" type="button" variant="outline">
                    <Trans>Cancel</Trans>
                </Button>
            </div>
        </form>
    );
};

export default DiffCommentForm;
