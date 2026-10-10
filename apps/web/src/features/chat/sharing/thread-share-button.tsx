import { Field } from "@base-ui/react/field";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Switch } from "@neore/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import cn from "@neore/ui/utils/cn";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import React, { useCallback, useState } from "react";
import { toast } from "sonner";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { getValidThreadId } from "@/features/chat/core/hooks/use-validated-thread";
import { useCRPC } from "@/lib/lunora/crpc";

interface ThreadShareButtonProperties {
    classes?: {
        button?: string;
        icon?: string;
    };
    threadId?: string;
}

type Permission = "read" | "write" | "admin";
type ExpirationType = "1_day" | "7_days" | "custom";

const ThreadShareButton: React.FC<ThreadShareButtonProperties> = ({ classes, threadId }) => {
    const [inviteEmail, setInviteEmail] = useState("");
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [invitePermission, setInvitePermission] = useState<Permission>("read");
    const [expirationType, setExpirationType] = useState<ExpirationType>("7_days");
    const [customHours, setCustomHours] = useState<number>(24);
    const [tab, setTab] = useState("access");
    const [userToRemove, setUserToRemove] = useState<{ name: string; userId: Id<"users"> } | null>(null);

    const actualThreadId = getValidThreadId(threadId);
    const canShare = !!actualThreadId;

    const { data: threadAccess } = useQuery(crpc.chat.sharing.getThreadAccess.queryOptions(actualThreadId ? { threadId: actualThreadId } : skipToken));
    const { data: threadInvites } = useQuery(crpc.chat.sharing.getThreadInvites.queryOptions(actualThreadId ? { threadId: actualThreadId } : skipToken));

    const { mutateAsync: createInviteMutation } = useMutation(crpc.chat.sharing.createThreadInvite.mutationOptions());
    const { mutateAsync: revokeInviteMutation } = useMutation(crpc.chat.sharing.revokeThreadInvite.mutationOptions());
    const { mutateAsync: removeAccessMutation } = useMutation(crpc.chat.sharing.removeThreadAccess.mutationOptions());
    const { mutateAsync: toggleVisibilityMutation } = useMutation(crpc.chat.sharing.toggleThreadVisibility.mutationOptions());

    const handleTabChange = useCallback((value: string) => setTab(value), []);
    const handleInviteEmailChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(event.target.value), []);
    const handleInvitePermissionChange = useCallback((value: Permission | null) => {
        if (value) {
            setInvitePermission(value);
        }
    }, []);
    const handleExpirationTypeChange = useCallback((value: ExpirationType | null) => {
        if (value) {
            setExpirationType(value);
        }
    }, []);
    const handleCustomHoursChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => setCustomHours(Math.trunc(Number(event.target.value)) || 1),
        [],
    );

    const handleCreateInvite = useCallback(async () => {
        if (!inviteEmail.trim()) {
            toast.error(t`Please enter an email address`);

            return;
        }

        if (!actualThreadId) {
            return;
        }

        try {
            const result = await createInviteMutation({
                customHours: expirationType === "custom" ? customHours : undefined,
                expirationType,
                invitedEmail: inviteEmail.trim(),
                permission: invitePermission,
                threadId: actualThreadId,
            });
            const inviteLink = `${globalThis.location.origin}/invite/${result.inviteToken}`;

            await navigator.clipboard.writeText(inviteLink);
            toast.success(t`Invite link copied to clipboard!`);
            setInviteEmail("");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t`Failed to create invite`);
        }
    }, [inviteEmail, expirationType, customHours, invitePermission, actualThreadId, createInviteMutation, t]);

    const handleRevokeInvite = useCallback(
        async (inviteId: Id<"threadInvites">) => {
            try {
                await revokeInviteMutation({ inviteId });
                toast.success(t`Invite revoked`);
            } catch {
                toast.error(t`Failed to revoke invite`);
            }
        },
        [revokeInviteMutation, t],
    );

    const handleRemoveAccess = useCallback(
        async (userId: Id<"users">) => {
            if (!actualThreadId) {
                return;
            }

            try {
                await removeAccessMutation({ targetUserId: userId, threadId: actualThreadId });
                toast.success(t`User access removed`);
            } catch {
                toast.error(t`Failed to remove user access`);
            }
        },
        [actualThreadId, removeAccessMutation, t],
    );

    const handleToggleVisibility = useCallback(
        (isPublic: boolean) => {
            if (!actualThreadId) {
                return;
            }

            (async () => {
                try {
                    await toggleVisibilityMutation({ isPublic, threadId: actualThreadId });
                    toast.success(isPublic ? t`Thread made public` : t`Thread made private`);
                } catch {
                    toast.error(t`Failed to update thread visibility`);
                }
            })();
        },
        [actualThreadId, toggleVisibilityMutation, t],
    );

    const copyPublicLink = useCallback(async () => {
        if (!threadAccess?.publicAccessToken) {
            return;
        }

        const publicLink = `${globalThis.location.origin}/thread/${threadAccess.publicAccessToken}`;

        await navigator.clipboard.writeText(publicLink);
        toast.success(t`Public link copied to clipboard!`);
    }, [threadAccess, t]);

    if (!canShare) {
        return null;
    }

    if (!threadAccess) {
        return (
            <Button className={cn(classes?.button, "cursor-not-allowed", "group")} disabled size="icon" variant="ghost">
                <Share2 className={cn(classes?.icon, "h-4 w-4 animate-pulse", "transition-opacity duration-200", "group-hover:opacity-50")} />
                <span className="sr-only">{t`Share Thread`}</span>
            </Button>
        );
    }

    const formatExpirationTime = (timestamp: number) => formatDateTime(timestamp, i18n.locale);

    const getPermissionLabel = (permission: string): string => {
        switch (permission) {
            case "admin": {
                return t`Admin`;
            }
            case "read": {
                return t`Read Only`;
            }
            case "write": {
                return t`Read & Write`;
            }
            default: {
                return permission;
            }
        }
    };

    const userToRemoveName = userToRemove?.name;

    const getPermissionColor = (permission: string) => {
        switch (permission) {
            case "admin": {
                return "destructive";
            }
            case "read": {
                return "secondary";
            }
            case "write": {
                return "default";
            }
            default: {
                return "secondary";
            }
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button className={cn(classes?.button, "text-white")} size="icon" variant="ghost">
                        <Share2 className={cn(classes?.icon, "h-4 w-4")} />
                        <span className="sr-only">{t`Share Thread`}</span>
                    </Button>
                }
            />
            <DropdownMenuContent className="w-[420px] p-0">
                <Tabs className="w-full" onValueChange={handleTabChange} value={tab}>
                    <TabsList className="grid w-full grid-cols-3">
                        <TabsTrigger value="access">{t`Access`}</TabsTrigger>
                        <TabsTrigger value="invites">{t`Invites`}</TabsTrigger>
                        <TabsTrigger value="public">{t`Public`}</TabsTrigger>
                    </TabsList>
                    <TabsContent className="px-4 py-2" value="access">
                        {threadAccess.users.length === 0 ? (
                            <p className="text-muted-foreground text-sm">{t`No additional users have access to this thread.`}</p>
                        ) : (
                            threadAccess.users.map((user) => (
                                <div className="flex items-center justify-between rounded-lg border p-3" key={user.userId}>
                                    <div className="flex items-center gap-3">
                                        <Avatar className="h-8 w-8">
                                            <AvatarImage src="" />
                                            <AvatarFallback name={user.name || user.email}>{user.name?.[0] || user.email[0]}</AvatarFallback>
                                        </Avatar>
                                        <div>
                                            <p className="text-sm font-medium">{user.name || user.email}</p>
                                            <p className="text-muted-foreground text-xs">{user.email}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Badge variant={getPermissionColor(user.permission)}>{getPermissionLabel(user.permission)}</Badge>
                                        {threadAccess.isOwner && (
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    className="text-destructive border-destructive hover:bg-destructive hover:text-destructive-foreground"
                                                    onClick={() => {
                                                        setUserToRemove({
                                                            name: user.name || user.email || t`user`,
                                                            userId: user.userId as Id<"users">,
                                                        });
                                                    }}
                                                    size="sm"
                                                    variant="outline"
                                                >
                                                    {t`Remove`}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </TabsContent>
                    <TabsContent className="flex flex-col gap-2 px-4 py-2" value="invites">
                        <Field.Root className="space-y-2">
                            <Label htmlFor="email">{t`Email Address`}</Label>
                            <Input id="email" onChange={handleInviteEmailChange} placeholder={t`Enter email address`} type="email" value={inviteEmail} />
                        </Field.Root>
                        <Field.Root className="space-y-2">
                            <Label htmlFor="permission">{t`Permission Level`}</Label>
                            <Select onValueChange={handleInvitePermissionChange} value={invitePermission}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="read">{t`Read Only`}</SelectItem>
                                    <SelectItem value="write">{t`Read & Write`}</SelectItem>
                                    <SelectItem value="admin">{t`Admin`}</SelectItem>
                                </SelectContent>
                            </Select>
                        </Field.Root>
                        <Field.Root className="space-y-2">
                            <Label htmlFor="expiration">{t`Expiration`}</Label>
                            <Select onValueChange={handleExpirationTypeChange} value={expirationType}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="1_day">{t`1 Day`}</SelectItem>
                                    <SelectItem value="7_days">{t`7 Days`}</SelectItem>
                                    <SelectItem value="custom">{t`Custom`}</SelectItem>
                                </SelectContent>
                            </Select>
                        </Field.Root>
                        {expirationType === "custom" && (
                            <Field.Root className="space-y-2">
                                <Label htmlFor="customHours">{t`Hours`}</Label>
                                <Input id="customHours" min="1" onChange={handleCustomHoursChange} type="number" value={customHours} />
                            </Field.Root>
                        )}
                        <Button className="w-full" onClick={handleCreateInvite}>
                            {t`Create Invite`}
                        </Button>
                        {threadInvites && threadInvites.length > 0 && (
                            <>
                                <hr className="my-2" />
                                <h2>{t`Pending Invites`}</h2>
                                {threadInvites.map((invite) => (
                                    <div className="flex items-center justify-between rounded-lg border p-3" key={invite._id}>
                                        <div className="flex items-center gap-3">
                                            <Share2 aria-hidden="true" className="text-muted-foreground h-4 w-4" />
                                            <div>
                                                <p className="text-sm font-medium">{invite.invitedEmail}</p>
                                                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                                                    {t`Expires:`} {formatExpirationTime(invite.expiresAt)}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Badge variant={getPermissionColor(invite.permission)}>{getPermissionLabel(invite.permission)}</Badge>
                                            <Button
                                                className="text-destructive hover:text-destructive"
                                                onClick={() => handleRevokeInvite(invite._id as Id<"threadInvites">)}
                                                size="sm"
                                                variant="ghost"
                                            >
                                                {t`Remove`}
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                    </TabsContent>
                    <TabsContent className="px-4 py-2" value="public">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="font-medium">{t`Public Access`}</p>
                                <p className="text-muted-foreground text-sm">{t`Anyone with the link can view this thread`}</p>
                            </div>
                            <Switch
                                aria-label={t`Public Access`}
                                checked={threadAccess.isPublic}
                                disabled={!threadAccess.isOwner}
                                onCheckedChange={handleToggleVisibility}
                            />
                        </div>
                        {threadAccess.isPublic && threadAccess.publicAccessToken && (
                            <Field.Root className="space-y-2">
                                <Label>{t`Public Link`}</Label>
                                <div className="flex gap-2">
                                    <Input readOnly value={`${globalThis.location.origin}/thread/${threadAccess.publicAccessToken}`} />
                                    <Button onClick={copyPublicLink} variant="outline">
                                        {t`Copy`}
                                    </Button>
                                </div>
                            </Field.Root>
                        )}
                    </TabsContent>
                </Tabs>
            </DropdownMenuContent>
            <DeleteConfirmationDialog
                description={t`Are you sure you want to remove ${userToRemoveName} from this thread?`}
                itemName={userToRemove?.name}
                onConfirm={async () => {
                    if (!(userToRemove && actualThreadId)) {
                        return;
                    }

                    await handleRemoveAccess(userToRemove.userId);
                    setUserToRemove(null);
                }}
                onOpenChange={(open) => {
                    if (!open) {
                        setUserToRemove(null);
                    }
                }}
                open={!!userToRemove}
                title={t`Remove User`}
            />
        </DropdownMenu>
    );
};

export default ThreadShareButton;
