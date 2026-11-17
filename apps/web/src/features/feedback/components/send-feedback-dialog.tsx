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

/** Downscales and uploads each image, then sends the feedback with their upload ids. `false` when any step failed. */
const sendFeedback = async ({ images, kind, message, pagePath, submit }: SendInput): Promise<boolean> => {
    try {
        const uploadIds: string[] = [];

        for (const image of images) {
            const prepared = await downscaleOversizedImage(image.file);

            uploadIds.push(await uploadFile(prepared, { contentType: prepared.type }));
        }

        await submit({ kind, message, pagePath, uploadIds });

        return true;
    } catch {
        return false;
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
    const [sendFailed, setSendFailed] = useState(false);
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

    const onDrop = (event: DragEvent) => {
        event.preventDefault();
        addImages([...event.dataTransfer.files]);
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
        setSendFailed(false);

        const sent = await sendFeedback({ images, kind, message: message.trim(), pagePath: includePage ? pathname : undefined, submit });

        setSending(false);

        if (!sent) {
            // Kept in the dialog, beside the text the user may want to send again.
            setSendFailed(true);

            return;
        }

        showSuccess(t`Thanks! Your feedback was sent.`);
        reset();
        onOpenChange(false);
    };

    const canSend = message.trim().length > 0 && !sending;

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent onDragOver={(event: DragEvent) => event.preventDefault()} onDrop={onDrop}>
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
                            onPaste={onPaste}
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
                                        className="bg-background absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border"
                                        onClick={() => removeImage(image)}
                                        type="button"
                                    >
                                        <X aria-hidden="true" className="size-3" />
                                    </button>
                                </li>
                            ))}
                            {images.length < MAX_FEEDBACK_IMAGES ? (
                                <li>
                                    <Button className="size-16" onClick={() => fileInputRef.current?.click()} type="button" variant="outline">
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
                            {t`Large photos are made smaller before sending (up to ${Math.floor(MAX_FEEDBACK_IMAGE_BYTES / 1024 / 1024)} MB each).`}
                        </p>
                    </div>

                    <div className="flex items-start gap-2">
                        <Checkbox checked={includePage} id={pageId} onCheckedChange={(checked) => setIncludePage(checked === true)} />
                        <label className="grid gap-0.5 text-sm" htmlFor={pageId}>
                            {t`Include the page you are on`}
                            <code className="text-muted-foreground text-xs break-all">{pathname}</code>
                        </label>
                    </div>

                    {sendFailed ? (
                        <p className="text-destructive text-sm" role="alert">
                            {t`Your feedback could not be sent. Please try again.`}
                        </p>
                    ) : null}

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
            </DialogContent>
        </Dialog>
    );
};

export default SendFeedbackDialog;
