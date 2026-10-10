import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { formatDate, formatNumber } from "@neore/ui/utils/locale-format";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Copy, Key, Plus, XCircle } from "lucide-react";
import { useId, useRef, useState } from "react";

import { useCreateGatewayKey, useGatewayKeys, useRevokeGatewayKey } from "@/features/admin/hooks/use-admin";

// ── Helpers ───────────────────────────────────────────────────────────────────

const formatBudget = (spent: number, max: number | null): string => {
    const spentString = `$${spent.toFixed(4)}`;

    if (max === null) return `${spentString} / ∞`;

    return `${spentString} / $${max.toFixed(2)}`;
};

interface GatewayKeyEntry {
    createdAt: string;
    expiresAt: string | null;
    isActive: boolean;
    keyId: string;
    lastUsedAt: string | null;
    maxBudgetUsd: number | null;
    name: string;
    prefix: string;
    rpmLimit: number;
    spentUsd: number;
    tier: string;
    tpmLimit: number;
}

const getKeyStatus = (key: { expiresAt: string | null; isActive: boolean }): "active" | "expired" | "revoked" => {
    if (!key.isActive) return "revoked";

    if (key.expiresAt && new Date(key.expiresAt) < new Date()) return "expired";

    return "active";
};

const statusConfig: Record<"active" | "expired" | "revoked", { className: string; Icon: typeof CheckCircle2; label: MessageDescriptor }> = {
    active: { className: "text-green-600 dark:text-green-400", Icon: CheckCircle2, label: msg`Active` },
    expired: { className: "text-amber-600 dark:text-amber-400", Icon: XCircle, label: msg`Expired` },
    revoked: { className: "text-destructive", Icon: XCircle, label: msg`Revoked` },
};

const tierColors: Record<string, string> = {
    enterprise: "bg-purple-500/20 text-purple-700 dark:text-purple-400",
    free: "bg-muted text-muted-foreground",
    pro: "bg-blue-500/20 text-blue-700 dark:text-blue-400",
};

// ── Create Key Modal ──────────────────────────────────────────────────────────

type CreateKeyResult = {
    name: string;
    prefix: string;
    rawKey: string;
};

const CreateKeyModal = ({ userId, onCreated }: { onCreated: () => void; userId: string }) => {
    const { t } = useLingui();
    const nameId = useId();
    const tierId = useId();
    const budgetId = useId();
    const rpmId = useId();

    const [open, setOpen] = useState(false);
    const [createdKey, setCreatedKey] = useState<CreateKeyResult | null>(null);
    const [copied, setCopied] = useState(false);
    const { mutateAsync: createKey, isPending } = useCreateGatewayKey();

    const nameRef = useRef<HTMLInputElement>(null);
    const budgetRef = useRef<HTMLInputElement>(null);
    const rpmRef = useRef<HTMLInputElement>(null);
    const [tier, setTier] = useState<"free" | "pro" | "enterprise">("free");

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        const name = nameRef.current?.value.trim() || "Default";
        const budgetValue = budgetRef.current?.value;
        const rpmValue = rpmRef.current?.value;

        const result = await createKey({
            userId,
            name,
            tier,
            maxBudgetUsd: budgetValue ? Number(budgetValue) : undefined,
            rpmLimit: rpmValue ? Number(rpmValue) : undefined,
        });

        setCreatedKey({ rawKey: result.rawKey, prefix: result.prefix, name: result.name });
        onCreated();
    };

    const handleCopy = async () => {
        if (!createdKey) return;

        await navigator.clipboard.writeText(createdKey.rawKey);
        setCopied(true);
        setTimeout(setCopied, 2000, false);
    };

    const handleClose = () => {
        setOpen(false);
        setCreatedKey(null);
        setCopied(false);
    };

    return (
        <Dialog
            onOpenChange={(v) => {
                if (v) {
                    setOpen(true);
                } else {
                    handleClose();
                }
            }}
            open={open}
        >
            <DialogTrigger
                render={
                    <Button size="sm">
                        <Plus aria-hidden="true" className="size-4" />
                        <Trans>Create Key</Trans>
                    </Button>
                }
            />
            <DialogContent>
                {createdKey ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>
                                <Trans>Key Created</Trans>
                            </DialogTitle>
                            <DialogDescription>
                                <Trans>Copy and store your API key now — it will not be shown again.</Trans>
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-3">
                            <div>
                                <p className="text-muted-foreground mb-1 text-xs font-medium">
                                    <Trans>Name</Trans>
                                </p>
                                <p className="text-sm font-medium">{createdKey.name}</p>
                            </div>
                            <div>
                                <p className="text-muted-foreground mb-1 text-xs font-medium">
                                    <Trans>API Key</Trans>
                                </p>
                                <div className="bg-muted flex items-center gap-2 rounded-md px-3 py-2">
                                    <code className="flex-1 overflow-x-auto text-xs">{createdKey.rawKey}</code>
                                    <Button aria-label={t`Copy API key`} onClick={handleCopy} size="sm" variant="ghost">
                                        {copied ? <CheckCircle2 className="size-4 text-green-500" /> : <Copy className="size-4" />}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <DialogFooter>
                            <Button onClick={handleClose} variant="outline">
                                <Trans>Done</Trans>
                            </Button>
                        </DialogFooter>
                    </>
                ) : (
                    <form onSubmit={handleCreate}>
                        <DialogHeader>
                            <DialogTitle>
                                <Trans>Create API Key</Trans>
                            </DialogTitle>
                            <DialogDescription>
                                <Trans>Generate a new virtual API key with optional budget and rate limits.</Trans>
                            </DialogDescription>
                        </DialogHeader>

                        <div className="my-4 space-y-4">
                            <div className="space-y-1.5">
                                <Label htmlFor={nameId}>
                                    <Trans>Name</Trans>
                                </Label>
                                <Input defaultValue="Default" id={nameId} placeholder={t`My API Key`} ref={nameRef} />
                            </div>

                            <div className="space-y-1.5">
                                <Label htmlFor={tierId}>
                                    <Trans>Tier</Trans>
                                </Label>
                                <Select onValueChange={(v) => v && setTier(v as "free" | "pro" | "enterprise")} value={tier}>
                                    <SelectTrigger id={tierId}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="free">
                                            <Trans>Free</Trans>
                                        </SelectItem>
                                        <SelectItem value="pro">
                                            <Trans>Pro</Trans>
                                        </SelectItem>
                                        <SelectItem value="enterprise">
                                            <Trans>Enterprise</Trans>
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1.5">
                                    <Label htmlFor={budgetId}>
                                        <Trans>Max Budget (USD)</Trans>
                                    </Label>
                                    <Input id={budgetId} min="0" placeholder={t`Unlimited`} ref={budgetRef} step="0.01" type="number" />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor={rpmId}>
                                        <Trans>RPM Limit</Trans>
                                    </Label>
                                    <Input defaultValue="60" id={rpmId} min="1" ref={rpmRef} type="number" />
                                </div>
                            </div>
                        </div>

                        <DialogFooter>
                            <DialogClose
                                render={
                                    <Button type="button" variant="outline">
                                        <Trans>Cancel</Trans>
                                    </Button>
                                }
                            />
                            <Button disabled={isPending} type="submit">
                                {isPending ? t`Creating…` : t`Create Key`}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
};

// ── Revoke Confirmation Dialog ────────────────────────────────────────────────

const RevokeDialog = ({ keyId, prefix, onRevoked }: { keyId: string; onRevoked: () => void; prefix: string }) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);
    const { mutateAsync: revokeKey, isPending } = useRevokeGatewayKey();

    const handleRevoke = async () => {
        await revokeKey(keyId);
        setOpen(false);
        onRevoked();
    };

    return (
        <Dialog onOpenChange={setOpen} open={open}>
            <DialogTrigger
                render={
                    <Button aria-label={t`Revoke key ${prefix}`} size="sm" variant="ghost">
                        <XCircle aria-hidden="true" className="text-destructive size-4" />
                    </Button>
                }
            />
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        <Trans>Revoke API Key</Trans>
                    </DialogTitle>
                    <DialogDescription>
                        <Trans>
                            Are you sure you want to revoke <strong>{prefix}…</strong>? This cannot be undone. Any requests using this key will immediately
                            return 401 Unauthorized.
                        </Trans>
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <DialogClose
                        render={
                            <Button variant="outline">
                                <Trans>Cancel</Trans>
                            </Button>
                        }
                    />
                    <Button disabled={isPending} onClick={handleRevoke} variant="destructive">
                        {isPending ? t`Revoking…` : t`Revoke Key`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

// ── Main Page ─────────────────────────────────────────────────────────────────

// Placeholder userId — in a real scenario this would come from a user selector or admin context.
const ADMIN_PLACEHOLDER_USER_ID = "admin";

const GatewayKeysPage = () => {
    const { i18n, t } = useLingui();
    const queryClient = useQueryClient();
    const [filterUserId, setFilterUserId] = useState(ADMIN_PLACEHOLDER_USER_ID);
    const filterUserRef = useRef<HTMLInputElement>(null);
    const filterId = useId();

    const { data: keys, isPending, error } = useGatewayKeys(filterUserId);

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: ["admin", "gateway-keys"] });
    };

    const handleFilterSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const value = filterUserRef.current?.value.trim();

        if (value) setFilterUserId(value);
    };

    const keysTable = keys?.length ? (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>
                        <Trans>Key / Name</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>Tier</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>Budget Used</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>RPM Limit</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>Created</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>Last Used</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>Status</Trans>
                    </TableHead>
                    <TableHead className="w-[60px]">
                        <span className="sr-only">
                            <Trans>Actions</Trans>
                        </span>
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {(keys as GatewayKeyEntry[]).map((key) => {
                    const status = getKeyStatus(key);
                    const { Icon: StatusIcon, label: statusLabel, className: statusClassName } = statusConfig[status];
                    const keyPrefix = key.prefix;

                    return (
                        <TableRow key={key.keyId}>
                            <TableCell>
                                <div className="flex items-center gap-1.5">
                                    <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{key.prefix}…</code>
                                    <Button
                                        aria-label={t`Copy key prefix ${keyPrefix}`}
                                        onClick={() => navigator.clipboard.writeText(key.prefix)}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <Copy aria-hidden="true" className="size-3" />
                                    </Button>
                                </div>
                                <div className="text-muted-foreground text-xs">{key.name}</div>
                            </TableCell>
                            <TableCell>
                                <span className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${tierColors[key.tier] ?? ""}`}>{key.tier}</span>
                            </TableCell>
                            <TableCell className="text-sm">{formatBudget(key.spentUsd, key.maxBudgetUsd)}</TableCell>
                            <TableCell className="text-sm">{formatNumber(key.rpmLimit, i18n.locale)}/min</TableCell>
                            <TableCell className="text-muted-foreground text-xs" suppressHydrationWarning>
                                {formatDate(key.createdAt, i18n.locale)}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs" suppressHydrationWarning>
                                {key.lastUsedAt ? formatDate(key.lastUsedAt, i18n.locale) : t`Never`}
                            </TableCell>
                            <TableCell>
                                <span className={`flex items-center gap-1 text-xs font-medium ${statusClassName}`}>
                                    <StatusIcon aria-hidden="true" className="size-3" />
                                    {i18n._(statusLabel)}
                                </span>
                            </TableCell>
                            <TableCell>{status === "active" && <RevokeDialog keyId={key.keyId} onRevoked={refresh} prefix={key.prefix} />}</TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    ) : (
        <p className="text-muted-foreground py-8 text-center text-sm">
            <Trans>No API keys found for this user. Create one to get started.</Trans>
        </p>
    );

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Key aria-hidden="true" className="size-4" />
                            <Trans>Virtual API Keys</Trans>
                        </CardTitle>
                        <CardDescription>
                            <Trans>Manage gateway API keys with per-key budgets and rate limits</Trans>
                        </CardDescription>
                    </div>
                    <CreateKeyModal onCreated={refresh} userId={filterUserId} />
                </CardHeader>

                <CardContent className="space-y-4">
                    {/* User filter */}
                    <form className="flex items-center gap-2" onSubmit={handleFilterSubmit}>
                        <Label className="sr-only" htmlFor={filterId}>
                            <Trans>Filter by User ID</Trans>
                        </Label>
                        <Input
                            className="max-w-xs"
                            defaultValue={ADMIN_PLACEHOLDER_USER_ID}
                            id={filterId}
                            placeholder={t`Filter by User ID`}
                            ref={filterUserRef}
                        />
                        <Button size="sm" type="submit" variant="outline">
                            <Trans>Filter</Trans>
                        </Button>
                    </form>

                    {error && (
                        <p className="text-destructive text-sm">
                            <Trans>Failed to load keys. Ensure the LLM Gateway is running.</Trans>
                        </p>
                    )}

                    {isPending ? (
                        <div className="space-y-2">
                            {[1, 2, 3].map((i) => (
                                <Skeleton className="h-12 w-full" key={i} />
                            ))}
                        </div>
                    ) : (
                        keysTable
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

export const Route = createFileRoute("/admin/gateway/keys")({
    component: GatewayKeysPage,
});
