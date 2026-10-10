import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Input } from "@neore/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { useMutation } from "@tanstack/react-query";
import { FileUp, Plus, Search, Wand2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useCheckout from "@/features/billing/hooks/use-checkout";
import { useCRPCClient, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { createJsZip } from "@/lib/zip";

import { buildSkillDownload, saveBlob } from "../lib/skill-archive";
import type { SkillFormValues } from "../lib/skill-form";
import { toSkillPayload } from "../lib/skill-form";
import MarketplaceSkillDetailDialog from "./marketplace-skill-detail-dialog";
import type { SkillBuilderSaved } from "./skill-builder-dialog";
import SkillBuilderDialog from "./skill-builder-dialog";
import SkillBuilderSetup, { useBuilderSetupState } from "./skill-builder-setup";
import SkillEmptyState from "./skill-empty-state";
import SkillFormDialog from "./skill-form-dialog";
import type { ListedSkill } from "./skill-item";
import SkillItem from "./skill-item";

// Opened on demand; it pulls the SKILL.md parser and, for a .zip, JSZip.
const SkillImportDialog = lazy(() => import("./skill-import-dialog"));

type SortOption = "recent" | "mostUsed" | "alphabetical";

interface SkillListProps {
    /** Bumped by the parent when something outside this list (a marketplace fork) added a skill. */
    reloadKey?: number;
}

const SkillList = ({ reloadKey = 0 }: SkillListProps) => {
    const { t } = useLingui();
    const { upgradeToast } = useCheckout();
    const crpcClient = useCRPCClient();
    const [searchQuery, setSearchQuery] = useState("");
    const [sortBy, setSortBy] = useState<SortOption>("recent");
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [editingSkill, setEditingSkill] = useState<Doc<"skills"> | null>(null);
    const [deletingSkill, setDeletingSkill] = useState<Doc<"skills"> | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [busySkillId, setBusySkillId] = useState<string | null>(null);
    // Agent builder: the dialog, the integrations left to set up after a save,
    // and a marketplace skill it suggested using instead.
    const [isBuilderOpen, setIsBuilderOpen] = useState(false);
    const [builderSetup, setBuilderSetup] = useBuilderSetupState();
    const [suggestedSkillId, setSuggestedSkillId] = useState<Id<"skills"> | null>(null);
    // Bumped after every write so the effect below refetches the list.
    const [localReloadKey, setLocalReloadKey] = useState(0);
    const [isImportOpen, setIsImportOpen] = useState(false);
    const { mutateAsync: exportSkill } = useMutation(useLunoraActionOptions(api.skills.io.exportSkill));

    // Auth
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const { data: activeOrganization } = hooks.useActiveOrganization();
    const isLoggedIn = !!sessionData?.user;
    const currentUserId = sessionData?.user?.id;

    // Fetch skills using action (with caching)
    const { mutateAsync: getSkills } = useMutation(useLunoraActionOptions(api.skills.functions.getSkills));
    const [skillsBase, setSkillsBase] = useState<ListedSkill[] | undefined>(undefined);

    // Fetch skill count using action (with caching)
    const { mutateAsync: getSkillCount } = useMutation(useLunoraActionOptions(api.skills.functions.getSkillCount));
    const [skillCount, setSkillCount] = useState<{ canCreate: boolean; count: number; isPremium: boolean; limit: number | null } | undefined>(undefined);

    // Load skills and count on mount and when sortBy changes
    useEffect(() => {
        let isCancelled = false;

        const load = async () => {
            const [skillsResult, count] = await Promise.all([getSkills({ sortBy }), getSkillCount({})]);

            if (isCancelled) {
                return;
            }

            setSkillsBase(skillsResult as unknown as ListedSkill[]);
            setSkillCount(count);
        };

        load().catch((error) => {
            console.error("Failed to load skills:", error);
            toast.error(t`Failed to load skills`);
        });

        return () => {
            isCancelled = true;
        };
    }, [getSkills, getSkillCount, sortBy, t, reloadKey, localReloadKey]);

    // Filter skills based on search query
    const filteredSkills = useMemo(() => {
        if (!skillsBase) {
            return [];
        }

        let filtered = skillsBase;

        // Filter by search query
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();

            filtered = filtered.filter(
                (skill) =>
                    skill.name.toLowerCase().includes(query) ||
                    skill.description.toLowerCase().includes(query) ||
                    skill.slug.toLowerCase().includes(query) ||
                    skill.category?.toLowerCase().includes(query),
            );
        }

        return filtered;
    }, [skillsBase, searchQuery]);

    const handleCreateSkill = useCallback(() => {
        if (!isLoggedIn) {
            toast.error(t`Please sign in to create skills`);

            return;
        }

        if (skillCount && !skillCount.canCreate) {
            upgradeToast(t`Free accounts are limited to 5 skills. Upgrade to Pro for unlimited skills.`);

            return;
        }

        setEditingSkill(null);
        setIsDialogOpen(true);
    }, [isLoggedIn, skillCount, t, upgradeToast]);

    const handleOpenBuilder = useCallback(() => {
        if (!isLoggedIn) {
            toast.error(t`Please sign in to create skills`);

            return;
        }

        if (skillCount && !skillCount.canCreate) {
            upgradeToast(t`Free accounts are limited to 5 skills. Upgrade to Pro for unlimited skills.`);

            return;
        }

        setIsBuilderOpen(true);
    }, [isLoggedIn, skillCount, t, upgradeToast]);

    const handleBuilderSaved = useCallback(
        (saved: SkillBuilderSaved) => {
            toast.success(t`Skill created`);
            setBuilderSetup(saved);
            setLocalReloadKey((key) => key + 1);
        },
        [setBuilderSetup, t],
    );

    const handleEditSkill = useCallback((skill: Doc<"skills">) => {
        setEditingSkill(skill);
        setIsDialogOpen(true);
    }, []);

    const handleCloseDialog = useCallback(() => {
        setIsDialogOpen(false);
        setEditingSkill(null);
    }, []);

    // Errors propagate to the dialog, which reports them and stays open.
    const handleSubmitSkill = useCallback(
        async (values: SkillFormValues) => {
            if (editingSkill) {
                const payload = toSkillPayload(values, editingSkill.config);
                const isOwner = editingSkill.userId === currentUserId;

                await crpcClient.mutation(api.skills.functions.updateSkill, {
                    ...payload,
                    skillId: editingSkill._id,
                    // Only the owner may re-scope; sending it unchanged from anyone else is refused.
                    visibility: isOwner ? payload.visibility : undefined,
                });
                toast.success(t`Skill updated`);
            } else {
                await crpcClient.mutation(api.skills.functions.createSkill, {
                    ...toSkillPayload(values),
                    source: { type: "editor" },
                });
                toast.success(t`Skill created`);
            }

            setLocalReloadKey((key) => key + 1);
        },
        [crpcClient, currentUserId, editingSkill, t],
    );

    const handleConfirmDelete = useCallback(async () => {
        if (!deletingSkill) {
            return;
        }

        setIsDeleting(true);

        try {
            await crpcClient.mutation(api.skills.functions.deleteSkill, { skillId: deletingSkill._id });
            toast.success(t`Skill deleted`);
            setDeletingSkill(null);
            setLocalReloadKey((key) => key + 1);
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to delete skill`);
        } finally {
            setIsDeleting(false);
        }
    }, [crpcClient, deletingSkill, t]);

    // Installed marketplace skills are read-only here: forking makes an editable
    // copy, uninstalling removes only this user's installation.
    const runInstalledAction = useCallback(
        async (skill: ListedSkill, action: "fork" | "uninstall") => {
            setBusySkillId(skill._id);

            try {
                if (action === "fork") {
                    const { forkedSkillId } = await crpcClient.mutation(api.skills.marketplace.forkSkill, { skillId: skill._id });

                    toast.success(t`Forked "${skill.name}" — opening your copy.`);
                    setLocalReloadKey((key) => key + 1);

                    const forked = await crpcClient.query(api.skills.functions.getSkill, { skillId: forkedSkillId });

                    // A fork is the caller's own, so this is the owner's full row.
                    if (forked?.isOwner) {
                        handleEditSkill(forked);
                    }
                } else {
                    await crpcClient.mutation(api.skills.marketplace.uninstallSkill, { skillId: skill._id });
                    toast.success(t`Uninstalled "${skill.name}"`);
                    setLocalReloadKey((key) => key + 1);
                }
            } catch (error) {
                toast.error(error instanceof Error && error.message ? error.message : t`Something went wrong. Try again.`);
            } finally {
                setBusySkillId(null);
            }
        },
        [crpcClient, handleEditSkill, t],
    );

    const handleExportSkill = useCallback(
        async (skill: ListedSkill) => {
            setBusySkillId(skill._id);

            try {
                const { blob, filename } = await buildSkillDownload(await exportSkill({ skillId: skill._id }), createJsZip);

                saveBlob(blob, filename);
            } catch (error) {
                console.error("Skill export failed:", error);
                toast.error(t`Failed to export skill`);
            } finally {
                setBusySkillId(null);
            }
        },
        [exportSkill, t],
    );

    const dialogs = (
        <>
            {isImportOpen && (
                <Suspense fallback={null}>
                    <SkillImportDialog onClose={() => setIsImportOpen(false)} onImported={() => setLocalReloadKey((key) => key + 1)} open={isImportOpen} />
                </Suspense>
            )}
            <SkillFormDialog
                canShareWithOrganization={!!activeOrganization}
                editingSkill={editingSkill}
                isOwner={!editingSkill || editingSkill.userId === currentUserId}
                onClose={handleCloseDialog}
                onSubmit={handleSubmitSkill}
                open={isDialogOpen}
            />
            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`This permanently deletes the skill and its history. Anyone who installed it loses access.`}
                loading={isDeleting}
                onConfirm={handleConfirmDelete}
                onOpenChange={(open) => !open && !isDeleting && setDeletingSkill(null)}
                open={deletingSkill !== null}
                title={deletingSkill ? t`Delete "${deletingSkill.name}"?` : t`Delete skill?`}
            />
            <SkillBuilderDialog
                onClose={() => setIsBuilderOpen(false)}
                onSaved={handleBuilderSaved}
                onUseMarketplaceSkill={setSuggestedSkillId}
                open={isBuilderOpen}
            />
            <MarketplaceSkillDetailDialog
                onClose={() => setSuggestedSkillId(null)}
                onForked={() => setLocalReloadKey((key) => key + 1)}
                skillId={suggestedSkillId}
            />
        </>
    );

    const builderButton = (
        <Button onClick={handleOpenBuilder} variant="outline">
            <Wand2 aria-hidden="true" className="mr-2 size-4" />
            {t`Build with AI`}
        </Button>
    );

    const importButton = (
        <Button
            onClick={() => {
                if (isLoggedIn) {
                    setIsImportOpen(true);
                } else {
                    toast.error(t`Please sign in to create skills`);
                }
            }}
            variant="outline"
        >
            <FileUp aria-hidden="true" className="mr-2 size-4" />
            {t`Import`}
        </Button>
    );

    // Show empty state if no skills
    if (skillsBase && skillsBase.length === 0) {
        return (
            <>
                <SkillEmptyState isLoggedIn={isLoggedIn} onCreateSkill={handleCreateSkill} skillCount={skillCount || null} />
                {isLoggedIn && (
                    <div className="mt-4 flex justify-center gap-2">
                        {builderButton}
                        {importButton}
                    </div>
                )}
                {dialogs}
            </>
        );
    }

    const setupPanel = builderSetup && <SkillBuilderSetup onDismiss={() => setBuilderSetup(null)} onDone={setBuilderSetup} pending={builderSetup} />;

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-1 items-center gap-2">
                    <div className="relative flex-1">
                        <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                            aria-label={t`Search your skills`}
                            className="pl-9"
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={t`Search skills...`}
                            type="search"
                            value={searchQuery}
                        />
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Select onValueChange={(value) => setSortBy(value as SortOption)} value={sortBy}>
                        <SelectTrigger aria-label={t`Sort skills`} className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="recent">{t`Recently Created`}</SelectItem>
                            <SelectItem value="mostUsed">{t`Most Used`}</SelectItem>
                            <SelectItem value="alphabetical">{t`Alphabetical`}</SelectItem>
                        </SelectContent>
                    </Select>
                    {builderButton}
                    {importButton}
                    <Button onClick={handleCreateSkill}>
                        <Plus aria-hidden="true" className="mr-2 size-4" />
                        {t`Add Skill`}
                    </Button>
                </div>
            </div>

            {setupPanel}

            {/* Skills Grid */}
            {filteredSkills.length === 0 ? (
                <div className="flex h-64 items-center justify-center rounded-lg border border-dashed">
                    <p className="text-muted-foreground">{t`No skills found matching your search`}</p>
                </div>
            ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredSkills.map((skill) => (
                        <SkillItem
                            canDelete={skill.userId === currentUserId}
                            isBusy={busySkillId === skill._id}
                            key={skill._id}
                            onDelete={setDeletingSkill}
                            onEdit={handleEditSkill}
                            onExport={handleExportSkill}
                            onFork={(target) => runInstalledAction(target, "fork")}
                            onUninstall={(target) => runInstalledAction(target, "uninstall")}
                            skill={skill}
                        />
                    ))}
                </div>
            )}

            {dialogs}
        </div>
    );
};

export default SkillList;
