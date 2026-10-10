"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Switch } from "@neore/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

type Permission = "admin" | "comment" | "read" | "write";

const PERMISSIONS: Permission[] = ["read", "comment", "write", "admin"];

const copy = async (value: string, done: string): Promise<void> => {
    try {
        await navigator.clipboard.writeText(value);
        showSuccess(done);
    } catch {
        showError(value);
    }
};

const PageShareDialogBody: FC<{ pageId: string }> = ({ pageId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const baseId = useId();
    const [invitePermission, setInvitePermission] = useState<Permission>("comment");
    const [inviteLink, setInviteLink] = useState<string | null>(null);
    // When the dialog opened: expiry is judged against it, not re-read on every render.
    const [openedAt] = useState(() => Date.now());
    const { data: sharing } = useQuery(crpc.pages.sharing.getPageSharing.queryOptions({ pageId: pageId as never }));
    const setPublic = useMutation(crpc.pages.sharing.setPagePublic.mutationOptions());
    const createInvite = useMutation(crpc.pages.sharing.createPageInvite.mutationOptions());
    const revokeInvite = useMutation(crpc.pages.sharing.revokePageInvite.mutationOptions());
    const updateGrant = useMutation(crpc.pages.sharing.updatePageGrant.mutationOptions());
    const removeGrant = useMutation(crpc.pages.sharing.removePageGrant.mutationOptions());

    const labels: Record<Permission, string> = { admin: t`Can manage`, comment: t`Can comment`, read: t`Can view`, write: t`Can edit` };
    const permissionItems = PERMISSIONS.map((value) => {
        return { label: labels[value], value };
    });
    const onError = (error: unknown) => showError(error instanceof Error ? error : t`Something went wrong`);
    const origin = typeof window === "undefined" ? "" : globalThis.location.origin;
    const publicLink = sharing?.publicAccessToken ? `${origin}/p/${sharing.publicAccessToken}` : null;
    const dateFormat = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" });

    return (
        <DialogPanel className="space-y-6">
            <section aria-labelledby={`${baseId}-public`} className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium" id={`${baseId}-public`}>
                            {t`Public link`}
                        </h3>
                        <p className="text-muted-foreground text-xs">{t`Anyone with the link can read this page. Comments are never shown. Turning it off revokes the link.`}</p>
                    </div>
                    <Switch
                        aria-labelledby={`${baseId}-public`}
                        checked={sharing?.isPublic ?? false}
                        disabled={!sharing || setPublic.isPending}
                        onCheckedChange={(checked) => setPublic.mutate({ isPublic: checked, pageId: pageId as never }, { onError })}
                    />
                </div>
                {publicLink && (
                    <div className="flex gap-2">
                        <Input aria-label={t`Public link`} readOnly value={publicLink} />
                        <Button
                            aria-label={t`Copy public link`}
                            onClick={() => {
                                void copy(publicLink, t`Link copied`);
                            }}
                            size="icon"
                            variant="outline"
                        >
                            <Copy aria-hidden="true" />
                        </Button>
                    </div>
                )}
            </section>

            <section aria-labelledby={`${baseId}-invite`} className="space-y-2">
                <h3 className="text-sm font-medium" id={`${baseId}-invite`}>
                    {t`Invite by link`}
                </h3>
                <p className="text-muted-foreground text-xs">{t`Creates a single-use link, valid for 7 days. Whoever opens it signed in gets access.`}</p>
                <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                        <Label id={`${baseId}-permission`}>{t`Access`}</Label>
                        <Select
                            items={permissionItems}
                            onValueChange={(value) => setInvitePermission((value ?? "comment") as Permission)}
                            value={invitePermission}
                        >
                            <SelectTrigger aria-labelledby={`${baseId}-permission`}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {permissionItems.map((item) => (
                                    <SelectItem key={item.value} value={item.value}>
                                        {item.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <Button
                        aria-busy={createInvite.isPending}
                        disabled={createInvite.isPending}
                        onClick={() =>
                            createInvite.mutate(
                                { expiresInDays: 7, pageId: pageId as never, permission: invitePermission },
                                { onError, onSuccess: ({ token }) => setInviteLink(`${origin}/pages/invite/${token}`) },
                            )
                        }
                    >
                        {t`Create link`}
                    </Button>
                </div>
                {inviteLink && (
                    <div className="space-y-1">
                        <div className="flex gap-2">
                            <Input aria-label={t`Invite link`} readOnly value={inviteLink} />
                            <Button
                                aria-label={t`Copy invite link`}
                                onClick={() => {
                                    void copy(inviteLink, t`Link copied`);
                                }}
                                size="icon"
                                variant="outline"
                            >
                                <Copy aria-hidden="true" />
                            </Button>
                        </div>
                        <p className="text-muted-foreground text-xs">{t`Copy it now — it is not shown again.`}</p>
                    </div>
                )}
            </section>

            <section aria-labelledby={`${baseId}-people`} className="space-y-2">
                <h3 className="text-sm font-medium" id={`${baseId}-people`}>
                    {t`People with access`}
                </h3>
                {sharing && sharing.grants.length === 0 && <p className="text-muted-foreground text-xs">{t`Only you.`}</p>}
                <ul className="space-y-2">
                    {sharing?.grants.map((grant) => {
                        const name = grant.name ?? grant.email ?? t`Unknown user`;

                        return (
                            <li className="flex items-center gap-2" key={grant.userId}>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm">{name}</span>
                                    {grant.email && grant.name && <span className="text-muted-foreground block truncate text-xs">{grant.email}</span>}
                                </span>
                                <Select
                                    items={permissionItems}
                                    onValueChange={(value) =>
                                        value &&
                                        updateGrant.mutate(
                                            { pageId: pageId as never, permission: value as Permission, targetUserId: grant.userId },
                                            { onError },
                                        )
                                    }
                                    value={grant.permission}
                                >
                                    <SelectTrigger aria-label={t`Access for ${name}`} className="w-36">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {permissionItems.map((item) => (
                                            <SelectItem key={item.value} value={item.value}>
                                                {item.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Button
                                    aria-label={t`Remove ${name}`}
                                    onClick={() => removeGrant.mutate({ pageId: pageId as never, targetUserId: grant.userId }, { onError })}
                                    size="icon"
                                    variant="ghost"
                                >
                                    <Trash2 aria-hidden="true" />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
                {(sharing?.invites.length ?? 0) > 0 && (
                    <>
                        <h4 className="text-muted-foreground pt-2 text-xs font-medium">{t`Open invite links`}</h4>
                        <ul className="space-y-1">
                            {sharing?.invites.map((invite) => {
                                const expired = invite.expiresAt < openedAt;

                                return (
                                    <li className="flex items-center justify-between gap-2 text-xs" key={invite._id}>
                                        <span className={expired ? "text-muted-foreground line-through" : undefined}>
                                            {labels[invite.permission]} · {expired ? t`expired` : t`until ${dateFormat.format(invite.expiresAt)}`}
                                        </span>
                                        <Button onClick={() => revokeInvite.mutate({ inviteId: invite._id as never }, { onError })} size="sm" variant="ghost">
                                            {t`Revoke`}
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </section>
        </DialogPanel>
    );
};

const PageShareDialog: FC<{ onClose: () => void; open: boolean; pageId: string }> = ({ onClose, open, pageId }) => {
    const { t } = useLingui();

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
            {open && (
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t`Share page`}</DialogTitle>
                        <DialogDescription>{t`Give people access to this page, or publish a read-only link.`}</DialogDescription>
                    </DialogHeader>
                    <PageShareDialogBody pageId={pageId} />
                </DialogContent>
            )}
        </Dialog>
    );
};

export default PageShareDialog;
