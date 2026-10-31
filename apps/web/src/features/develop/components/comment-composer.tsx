"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { useId, useState } from "react";

/**
 * A box for one comment. `onSubmit` answers `null` when it was taken, or the reason it was not,
 * which is shown under the box with the text kept so nothing typed is lost.
 */
const CommentComposer = ({
    initial = "",
    label,
    onCancel,
    onSubmit,
    submitLabel,
}: {
    initial?: string;
    label: string;
    onCancel: () => void;
    onSubmit: (body: string) => Promise<string | null>;
    submitLabel: string;
}) => {
    const { t } = useLingui();
    const id = useId();
    const [body, setBody] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    return (
        <form
            className="space-y-2"
            onSubmit={async (event) => {
                event.preventDefault();
                setPending(true);
                setError(null);

                try {
                    setError(await onSubmit(body));
                } catch {
                    setError(t`Could not save this. Try again.`);
                } finally {
                    setPending(false);
                }
            }}
        >
            <label className="sr-only" htmlFor={id}>
                {label}
            </label>
            <Textarea autoFocus disabled={pending} id={id} onChange={(event) => setBody(event.target.value)} value={body} />
            {error !== null && (
                <p className="text-destructive text-xs" role="alert">
                    {error}
                </p>
            )}
            <div className="flex gap-2">
                <Button disabled={pending || body.trim() === ""} size="sm" type="submit">
                    {submitLabel}
                </Button>
                <Button disabled={pending} onClick={onCancel} size="sm" type="button" variant="ghost">
                    {t`Cancel`}
                </Button>
            </div>
        </form>
    );
};

export default CommentComposer;
