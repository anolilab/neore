"use client";

import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { FEEDBACK_IMAGE_TYPES, MAX_FEEDBACK_IMAGE_BYTES, MAX_FEEDBACK_IMAGES, MAX_FEEDBACK_MESSAGE_LENGTH } from "@neore/backend/feedback-limits";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { useLocation } from "@tanstack/react-router";
import { ImagePlus, Loader2, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, FC } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { captureException } from "@/lib/analytics/posthog-client";
import { useAction } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";
import { downscaleOversizedImage } from "@/lib/upload/image-downscale";
import { uploadFile } from "@/lib/upload/upload-file";

import { acceptFeedbackImages } from "../lib/accept-images";

type FeedbackKind = "idea" | "other" | "problem";

const KINDS = [
    { label: msg`Idea`, value: "idea" },
    { label: msg`Problem`, value: "problem" },
    { label: msg`Other`, value: "other" },
] as const;

interface PickedImage {
    file: File;
    id: string;
    previewUrl: string;
}

interface SendInput {
    images: ReadonlyArray<PickedImage>;
    kind: FeedbackKind;
    message: string;
    pagePath: string | undefined;
    submit: (args: { kind: FeedbackKind; message: string; pagePath?: string; uploadIds: string[] }) => Promise<unknown>;
}

const MAX_FEEDBACK_IMAGE_MB = Math.floor(MAX_FEEDBACK_IMAGE_BYTES / 1024 / 1024);

type SendResult = { kind: "failed"; reason: FailureReason } | { kind: "sent" } | { kind: "too-large"; position: number };

/** Why a send failed, from the server's code: the hourly limit and a refused image are not fixed by sending again. */
type FailureReason = "other" | "rate-limited" | "refused";

const failureReasonOf = (error: unknown): FailureReason => {
    const { code } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown };

    if (code === "TOO_MANY_REQUESTS") {
        return "rate-limited";
    }

    if (code === "BAD_REQUEST" || code === "PAYLOAD_TOO_LARGE") {
        return "refused";
    }

    return "other";
};

/**
 * Downscales every image first: one still over the server's limit (a GIF or a transparent PNG is never re-encoded)
 * is named before anything is uploaded or sent, so a retry cannot fail the same way. Then uploads them and sends the
 * feedback with their upload ids.
 */
const sendFeedback = async ({ images, kind, message, pagePath, submit }: SendInput): Promise<SendResult> => {
    try {
        const prepared = await Promise.all(images.map(async (image) => await downscaleOversizedImage(image.file)));
        const oversized = prepared.findIndex((file) => file.size > MAX_FEEDBACK_IMAGE_BYTES);

        if (oversized !== -1) {
            return { kind: "too-large", position: oversized + 1 };
        }

        const uploadIds: string[] = [];

        for (const file of prepared) {
            uploadIds.push(await uploadFile(file, { contentType: file.type }));
        }

        await submit({ kind, message, pagePath, uploadIds });

        return { kind: "sent" };
    } catch (error) {
        const reason = failureReasonOf(error);

        if (reason === "other") {
            captureException(error);
        }

        return { kind: "failed", reason };
    }
};

export interface SendFeedbackDialogProperties {
    onOpenChange: (open: boolean) => void;
    open: boolean;
}

/** The "Send feedback" dialog: a kind, a text, up to four images (pick, paste or drop) and, if the user agrees, the page they are on. */
const SendFeedbackDialog: FC<SendFeedbackDialogProperties> = ({ onOpenChange, open }) => {
    const { i18n, t } = useLingui();
    const submit = useAction(api.feedback.functions.submitFeedback);
    const { pathname } = useLocation();
    const [kind, setKind] = useState<FeedbackKind>("idea");
    const [message, setMessage] = useState("");
    const [images, setImages] = useState<PickedImage[]>([]);
    const [includePage, setIncludePage] = useState(true);
    const [sending, setSending] = useState(false);
    const [pickerKey, setPickerKey] = useState(0);
    const [sendError, setSendError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const kindLabelId = useId();
    const messageId = useId();
    const pageId = useId();
    const imagesLabelId = useId();

    // The previews are object URLs: give them back when the dialog goes away.
    const imagesRef = useRef(images);

    useEffect(() => {
        imagesRef.current = images;
    }, [images]);
    useEffect(
        () => () => {
            for (const image of imagesRef.current) {
                URL.revokeObjectURL(image.previewUrl);
            }
        },
        [],
    );

    const addImages = (files: ReadonlyArray<File>) => {
        if (files.length === 0) {
            return;
        }

        const { accepted, rejected } = acceptFeedbackImages(images.length, files);

        if (rejected > 0) {
            showError(t`Only PNG, JPEG, WebP or GIF images can be attached, four at most.`);
        }

        setImages((current) => [
            ...current,
            ...accepted.map((file) => {
                return { file, id: crypto.randomUUID(), previewUrl: URL.createObjectURL(file) };
            }),
        ]);
    };

    const removeImage = (image: PickedImage) => {
        URL.revokeObjectURL(image.previewUrl);
        setImages((current) => current.filter((item) => item.id !== image.id));
    };

    const onPaste = (event: ClipboardEvent) => {
        const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));

        if (files.length > 0) {
            event.preventDefault();
            addImages(files);
        }
    };

    // Files only: dragged text still drops into the text box. A file is never left to the browser, which would open it
    // in place of the app; while sending it is not added.
    const onDragOver = (event: DragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) {
            return;
        }

        event.preventDefault();
    };

    const onDrop = (event: DragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) {
            return;
        }

        event.preventDefault();

        if (!sending) {
            addImages([...event.dataTransfer.files]);
        }
    };

    const reset = () => {
        for (const image of images) {
            URL.revokeObjectURL(image.previewUrl);
        }

        setImages([]);
        setMessage("");
        setKind("idea");
        setIncludePage(true);
    };

    const handleSend = async () => {
        setSending(true);
        setSendError(null);

        const result = await sendFeedback({ images, kind, message: message.trim(), pagePath: includePage ? pathname : undefined, submit });

        setSending(false);

        // Kept in the dialog, beside the text the user may want to send again.
        if (result.kind === "too-large") {
            setSendError(
                t`Attachment ${result.position} is over ${MAX_FEEDBACK_IMAGE_MB} MB and could not be made smaller. Remove it or attach a smaller image.`,
            );

            return;
        }

        if (result.kind === "failed") {
            const errors: Record<FailureReason, string> = {
                other: t`Your feedback could not be sent. Please try again.`,
                "rate-limited": t`You have sent a lot of feedback recently. Please try again in an hour.`,
                refused: t`An attached image was not accepted. Remove it or attach a PNG, JPEG, WebP or GIF image.`,
            };

            setSendError(errors[result.reason]);

            return;
        }

        showSuccess(t`Thanks! Your feedback was sent.`);
        reset();
        onOpenChange(false);
    };

    const canSend = message.trim().length > 0 && !sending;

    return (
        // Not closed while sending: the send goes on, and a reopened dialog could send it a second time.
        <Dialog dismissible={!sending} onOpenChange={(next) => (sending && !next ? undefined : onOpenChange(next))} open={open}>
            <DialogContent>
                {/* The drop target wraps the header and the form, not the content: the mobile sheet does not take the content's handlers. */}
                <div className="grid gap-4" onDragOver={onDragOver} onDrop={onDrop}>
                    <DialogHeader>
                        <DialogTitle>{t`Send feedback`}</DialogTitle>
                        <DialogDescription>{t`Tell us about an idea or a problem. You can paste or drop screenshots too.`}</DialogDescription>
                    </DialogHeader>

                    <form
                        className="grid gap-4"
                        onSubmit={(event) => {
                            event.preventDefault();

                            if (canSend) {
                                void handleSend();
                            }
                        }}
                    >
                        <div className="grid gap-2">
                            <span className="text-sm font-medium" id={kindLabelId}>
                                {t`What is it about?`}
                            </span>
                            <RadioGroup
                                aria-labelledby={kindLabelId}
                                className="flex flex-wrap gap-4"
                                disabled={sending}
                                onValueChange={(value) => setKind(value as FeedbackKind)}
                                value={kind}
                            >
                                {KINDS.map((option) => (
                                    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input
                                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm" key={option.value}>
                                        <RadioGroupItem value={option.value} />
                                        {i18n._(option.label)}
                                    </label>
                                ))}
                            </RadioGroup>
                        </div>

                        <div className="grid gap-2">
                            <label className="text-sm font-medium" htmlFor={messageId}>
                                {t`Your feedback`}
                            </label>
                            <Textarea
                                className="min-h-28"
                                id={messageId}
                                maxLength={MAX_FEEDBACK_MESSAGE_LENGTH}
                                onChange={(event) => setMessage(event.target.value)}
                                onPaste={sending ? undefined : onPaste}
                                readOnly={sending}
                                required
                                value={message}
                            />
                        </div>

                        <div className="grid gap-2">
                            <span className="text-sm font-medium" id={imagesLabelId}>
                                {t`Images (${MAX_FEEDBACK_IMAGES} at most)`}
                            </span>
                            <ul aria-labelledby={imagesLabelId} className="flex flex-wrap gap-2">
                                {images.map((image, index) => (
                                    <li className="relative" key={image.id}>
                                        <img alt={t`Attachment ${index + 1}`} className="size-16 rounded-md border object-cover" src={image.previewUrl} />
                                        <button
                                            aria-label={t`Remove attachment ${index + 1}`}
                                            className="group absolute -top-5 -right-5 flex size-11 items-center justify-center disabled:opacity-50"
                                            disabled={sending}
                                            onClick={() => removeImage(image)}
                                            type="button"
                                        >
                                            <span className="bg-background group-focus-visible:ring-ring flex size-6 items-center justify-center rounded-full border group-focus-visible:ring-2">
                                                <X aria-hidden="true" className="size-3" />
                                            </span>
                                        </button>
                                    </li>
                                ))}
                                {images.length < MAX_FEEDBACK_IMAGES ? (
                                    <li>
                                        <Button
                                            className="size-16"
                                            disabled={sending}
                                            onClick={() => fileInputRef.current?.click()}
                                            type="button"
                                            variant="outline"
                                        >
                                            <ImagePlus aria-hidden="true" />
                                            <span className="sr-only">{t`Add images`}</span>
                                        </Button>
                                    </li>
                                ) : null}
                            </ul>
                            <input
                                accept={FEEDBACK_IMAGE_TYPES.join(",")}
                                aria-hidden="true"
                                className="hidden"
                                key={pickerKey}
                                multiple
                                onChange={(event) => {
                                    addImages([...(event.target.files ?? [])]);
                                    // A fresh input, so picking the same file again still fires a change.
                                    setPickerKey((key) => key + 1);
                                }}
                                ref={fileInputRef}
                                tabIndex={-1}
                                type="file"
                            />
                            <p className="text-muted-foreground text-xs">
                                {t`Large photos are made smaller before sending; each image can be up to ${MAX_FEEDBACK_IMAGE_MB} MB.`}
                            </p>
                        </div>

                        <div className="flex items-start gap-2">
                            <Checkbox checked={includePage} disabled={sending} id={pageId} onCheckedChange={(checked) => setIncludePage(checked === true)} />
                            <label className="grid gap-0.5 text-sm" htmlFor={pageId}>
                                {t`Include the page you are on`}
                                <code className="text-muted-foreground text-xs break-all">{pathname}</code>
                            </label>
                        </div>

                        {sendError === null ? null : (
                            <p className="text-destructive text-sm" role="alert">
                                {sendError}
                            </p>
                        )}

                        <DialogFooter>
                            <Button disabled={sending} onClick={() => onOpenChange(false)} type="button" variant="outline">
                                {t`Cancel`}
                            </Button>
                            <Button disabled={!canSend} type="submit">
                                {sending ? <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" /> : null}
                                {sending ? t`Sending…` : t`Send`}
                            </Button>
                        </DialogFooter>
                    </form>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default SendFeedbackDialog;
