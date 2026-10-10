"use client";

import { useLingui } from "@lingui/react/macro";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@neore/ui/components/breadcrumb";
import { Button } from "@neore/ui/components/button";
import type { TiptapCanvasEditorRef } from "@neore/ui/components/tiptap-canvas-editor";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { JSONContent } from "@tiptap/core";
import { History, MessageSquare, MessageSquarePlus, Share2, Sparkles, Star } from "lucide-react";
import type { FC } from "react";
import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showWarning } from "@/lib/toast";

import usePagePresence from "../hooks/use-page-presence";
import { focusCommentAnchor, markSelection, removeCommentMark } from "../lib/comment-mark";
import type { RevisionConflict } from "../lib/revision-conflict";
import { readRevisionConflict } from "../lib/revision-conflict";
import PageAgentDialog from "./page-agent-dialog";
import type { DraftComment } from "./page-comments-panel";
import PageCommentsPanel from "./page-comments-panel";
import PageConflictBanner from "./page-conflict-banner";
import PageEditor from "./page-editor";
import PageKeptDraft from "./page-kept-draft";
import PageShareDialog from "./page-share-dialog";
import PageVersionPanel from "./page-version-panel";

type Permission = "admin" | "comment" | "read" | "write";

const LEVEL: Record<Permission, number> = { admin: 4, comment: 2, read: 1, write: 3 };

/** A remote update is not pulled into the editor while the user typed this recently — their typing would be lost. */
const LOCAL_EDIT_GRACE_MS = 5000;

const PageView: FC<{ pageId: string }> = ({ pageId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const titleId = useId();
    const pageQuery = crpc.pages.functions.getPage.queryOptions({ pageId: pageId as never });
    const { data: page, error, isPending } = useQuery(pageQuery);
    const editorRef = useRef<TiptapCanvasEditorRef>(null);
    /** The revision the editor's content derives from — every write is based on it. */
    const baseRevisionRef = useRef<number | null>(null);
    const lastLocalEditRef = useRef(0);
    const lastAppliedRef = useRef<string | null>(null);
    /** The newest local content while a conflict pauses autosave. */
    const pendingRef = useRef<{ json: JSONContent; markdown: string } | null>(null);
    const draftIdRef = useRef<string | null>(null);
    const [panel, setPanel] = useState<"comments" | "draft" | "history" | null>(null);
    const [draft, setDraft] = useState<DraftComment | null>(null);
    const [agentOpen, setAgentOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [title, setTitle] = useState<string | null>(null);
    const [conflict, setConflict] = useState<(RevisionConflict & { reason: "agent" | "edit" | "restore"; versionId?: string }) | null>(null);
    const [resolving, setResolving] = useState(false);
    const [keptDraft, setKeptDraft] = useState<string | null>(null);
    const presence = usePagePresence(pageId);
    const { markEditing } = presence;

    const { mutate: saveContent, mutateAsync: saveContentAsync } = useMutation(crpc.pages.functions.savePageContent.mutationOptions());
    const { mutateAsync: restoreVersionAsync } = useMutation(crpc.pages.functions.restorePageVersion.mutationOptions());
    const rename = useMutation(crpc.pages.functions.renamePage.mutationOptions());
    const setFavorite = useMutation(crpc.pages.functions.setPageFavorite.mutationOptions());
    const createComment = useMutation(crpc.pages.comments.createPageComment.mutationOptions());

    const permission = (page?.permission ?? "read") as Permission;
    const canWrite = LEVEL[permission] >= LEVEL.write;
    const canComment = LEVEL[permission] >= LEVEL.comment;
    const canManage = permission === "admin";

    useEffect(() => {
        draftIdRef.current = draft?.commentId ?? null;
    }, [draft]);

    /** Replaces the editor's document without it being saved back as a local edit. */
    const applyJson = useCallback((json: unknown) => {
        if (!json) {
            return;
        }

        lastAppliedRef.current = JSON.stringify(json);
        editorRef.current?.setJSON(json as JSONContent);
    }, []);

    const adoptRevision = useCallback((revision: number) => {
        baseRevisionRef.current = Math.max(baseRevisionRef.current ?? 0, revision);
    }, []);

    // Pull a collaborator's save (or a restore elsewhere) into the editor, unless
    // the user has unsaved typing — their next save then meets the revision
    // check, which merges comment-only changes and reports a real conflict.
    useEffect(() => {
        if (!page) {
            return;
        }

        if (baseRevisionRef.current === null || page.revision <= baseRevisionRef.current) {
            adoptRevision(page.revision);

            return;
        }

        if (conflict || Date.now() - lastLocalEditRef.current < LOCAL_EDIT_GRACE_MS) {
            return;
        }

        adoptRevision(page.revision);
        applyJson(page.contentJson);
    }, [page, conflict, adoptRevision, applyJson]);

    const reportConflict = useCallback(
        (failure: unknown, reason: "agent" | "edit" | "restore", pending: { json: JSONContent; markdown: string } | null, versionId?: string): boolean => {
            const details = readRevisionConflict(failure);

            if (!details) {
                return false;
            }

            pendingRef.current = pending;
            setConflict({ ...details, reason, versionId });

            return true;
        },
        [],
    );

    const handleSave = useCallback(
        (markdown: string, json: JSONContent) => {
            const sent = JSON.stringify(json);

            if (!canWrite || sent === lastAppliedRef.current) {
                return;
            }

            lastLocalEditRef.current = Date.now();
            markEditing();

            // Paused: keep the newest local text for "overwrite with mine".
            if (conflict) {
                pendingRef.current = { json, markdown };

                return;
            }

            saveContent(
                {
                    baseRevision: baseRevisionRef.current ?? 0,
                    content: markdown,
                    contentJson: json,
                    draftCommentId: draftIdRef.current ?? undefined,
                    pageId: pageId as never,
                },
                {
                    onError: (saveError) => {
                        if (!reportConflict(saveError, "edit", { json, markdown })) {
                            showError(saveError instanceof Error ? saveError : t`Could not save the page`);
                        }
                    },
                    onSuccess: (result) => {
                        adoptRevision(result.revision);

                        // The server changed comment marks. Adopt its document only if
                        // nothing was typed since — otherwise the next save carries both.
                        if (result.contentJson && JSON.stringify(editorRef.current?.getJSON()) === sent) {
                            applyJson(result.contentJson);
                        }
                    },
                },
            );
        },
        [adoptRevision, applyJson, canWrite, conflict, markEditing, pageId, reportConflict, saveContent, t],
    );

    if (isPending) {
        return (
            <p aria-live="polite" className="text-muted-foreground p-8 text-sm" role="status">
                {t`Loading page…`}
            </p>
        );
    }

    if (error || !page) {
        return (
            <div className="p-8 text-sm" role="alert">
                <p className="font-medium">{t`Page not found`}</p>
                <p className="text-muted-foreground">{t`It may have been deleted, or you no longer have access.`}</p>
            </div>
        );
    }

    const reloadFromServer = async (minimumRevision: number) => {
        const fresh = await queryClient.fetchQuery({ ...pageQuery, staleTime: 0 });

        baseRevisionRef.current = Math.max(fresh.revision, minimumRevision);
        applyJson(fresh.contentJson);
    };

    const handleOverwrite = async () => {
        if (!conflict) {
            return;
        }

        setResolving(true);

        try {
            if (conflict.reason === "restore" && conflict.versionId) {
                const result = await restoreVersionAsync({ baseRevision: conflict.revision, versionId: conflict.versionId as never });

                setConflict(null);
                await reloadFromServer(result.revision);

                return;
            }

            const pending = pendingRef.current;

            if (!pending) {
                setConflict(null);

                return;
            }

            const result = await saveContentAsync({
                baseRevision: conflict.revision,
                content: pending.markdown,
                contentJson: pending.json,
                draftCommentId: draftIdRef.current ?? undefined,
                pageId: pageId as never,
                reason: conflict.reason === "agent" ? "agent" : "edit",
            });

            baseRevisionRef.current = result.revision;
            pendingRef.current = null;
            setConflict(null);

            if (conflict.reason === "agent") {
                applyJson(result.contentJson ?? pending.json);
            } else if (result.contentJson) {
                applyJson(result.contentJson);
            }
        } catch (overwriteError) {
            // Someone saved again in between: show the newer conflict.
            if (!reportConflict(overwriteError, conflict.reason, pendingRef.current, conflict.versionId)) {
                showError(overwriteError instanceof Error ? overwriteError : t`Could not save the page`);
            }
        } finally {
            setResolving(false);
        }
    };

    const handleReload = () => {
        if (!conflict) {
            return;
        }

        const kept = pendingRef.current?.markdown ?? editorRef.current?.getMarkdown() ?? "";

        if (conflict.reason !== "restore" && kept.trim()) {
            setKeptDraft(kept);
            setPanel("draft");
            navigator.clipboard?.writeText(kept).catch(() => undefined);
        }

        baseRevisionRef.current = conflict.revision;
        pendingRef.current = null;
        applyJson(conflict.contentJson);
        setConflict(null);
    };

    const handleRestore = async (versionId: string): Promise<boolean> => {
        try {
            const result = await restoreVersionAsync({ baseRevision: baseRevisionRef.current ?? 0, versionId: versionId as never });

            await reloadFromServer(result.revision);

            return true;
        } catch (restoreError) {
            if (!reportConflict(restoreError, "restore", null, versionId)) {
                showError(restoreError instanceof Error ? restoreError : t`Could not restore this version`);
            }

            return false;
        }
    };

    const handleStartComment = () => {
        const editor = editorRef.current?.editor;

        if (!editor) {
            return;
        }

        if (draft) {
            removeCommentMark(editor, draft.commentId);
        }

        const commentId = crypto.randomUUID();
        const quote = markSelection(editor, commentId);

        if (!quote) {
            showWarning(t`Select some text to comment on`);

            return;
        }

        setDraft({ commentId, quote });
        setPanel("comments");
    };

    const handleSubmitDraft = async (body: string) => {
        const editorApi = editorRef.current;

        if (!draft || !editorApi) {
            return;
        }

        const result = await createComment.mutateAsync({
            baseRevision: baseRevisionRef.current ?? 0,
            body,
            commentId: draft.commentId,
            content: canWrite ? editorApi.getMarkdown() : undefined,
            contentJson: editorApi.getJSON(),
            pageId: pageId as never,
        });

        adoptRevision(result.revision);

        if (result.contentJson) {
            applyJson(result.contentJson);
        }

        setDraft(null);
    };

    const handleCancelDraft = () => {
        const editor = editorRef.current?.editor;

        if (draft && editor) {
            removeCommentMark(editor, draft.commentId);
        }

        setDraft(null);
    };

    const handleCommentDeleted = (commentId: string, revision: number | null) => {
        const editor = editorRef.current?.editor;

        // The server already stripped the mark; mirror it locally on the new revision.
        if (revision !== null) {
            adoptRevision(revision);
        }

        if (editor) {
            removeCommentMark(editor, commentId);
        }
    };

    const commitTitle = () => {
        if (title === null || !page || title.trim() === page.title) {
            setTitle(null);

            return;
        }

        rename.mutate(
            { pageId: pageId as never, title },
            {
                onError: (renameError) => showError(renameError instanceof Error ? renameError : t`Could not rename the page`),
                onSettled: () => setTitle(null),
            },
        );
    };

    const editorNames = presence.editors.map((other) => (other.isSelf ? t`You (another tab)` : other.userName)).join(", ");

    return (
        <div className="flex h-full min-w-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
                    <Breadcrumb className="min-w-0 flex-1">
                        <BreadcrumbList>
                            {page.breadcrumbs.map((crumb) => (
                                <Fragment key={crumb._id}>
                                    <BreadcrumbItem>
                                        <BreadcrumbLink render={<Link params={{ pageId: crumb._id }} to="/pages/$pageId" />}>
                                            {crumb.title || t`Untitled`}
                                        </BreadcrumbLink>
                                    </BreadcrumbItem>
                                    <BreadcrumbSeparator />
                                </Fragment>
                            ))}
                            <BreadcrumbItem>
                                <BreadcrumbPage className="truncate">{page.title || t`Untitled`}</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    {presence.others.length > 0 && (
                        <ul aria-label={t`Also viewing`} className="flex -space-x-1">
                            {presence.others.map((other, index) => (
                                <li
                                    className="ring-background flex size-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2"
                                    key={`${other.userName}-${String(index)}`}
                                    style={{ backgroundColor: other.userColor }}
                                    title={other.userName}
                                >
                                    <span aria-hidden="true">{other.userName.slice(0, 1).toUpperCase()}</span>
                                    <span className="sr-only">{other.userName}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="flex items-center gap-1">
                        <Button
                            aria-label={page.isFavorite ? t`Remove from favorites` : t`Add to favorites`}
                            aria-pressed={page.isFavorite}
                            onClick={() => setFavorite.mutate({ isFavorite: !page.isFavorite, pageId: pageId as never })}
                            size="icon-sm"
                            variant="ghost"
                        >
                            <Star aria-hidden="true" className={cn(page.isFavorite && "fill-amber-400 text-amber-500")} />
                        </Button>
                        {canComment && (
                            <Button onClick={handleStartComment} size="sm" variant="ghost">
                                <MessageSquarePlus aria-hidden="true" />
                                {t`Comment`}
                            </Button>
                        )}
                        {canWrite && (
                            <Button onClick={() => setAgentOpen(true)} size="sm" variant="ghost">
                                <Sparkles aria-hidden="true" />
                                {t`Page agent`}
                            </Button>
                        )}
                        <Button
                            aria-label={t`Comments`}
                            aria-pressed={panel === "comments"}
                            onClick={() => setPanel((current) => (current === "comments" ? null : "comments"))}
                            size="icon-sm"
                            variant="ghost"
                        >
                            <MessageSquare aria-hidden="true" />
                        </Button>
                        <Button
                            aria-label={t`Version history`}
                            aria-pressed={panel === "history"}
                            onClick={() => setPanel((current) => (current === "history" ? null : "history"))}
                            size="icon-sm"
                            variant="ghost"
                        >
                            <History aria-hidden="true" />
                        </Button>
                        {canManage && (
                            <Button onClick={() => setShareOpen(true)} size="sm" variant="outline">
                                <Share2 aria-hidden="true" />
                                {t`Share`}
                            </Button>
                        )}
                    </div>
                </header>
                {conflict && (
                    <PageConflictBanner
                        onOverwrite={() => {
                            void handleOverwrite();
                        }}
                        onReload={handleReload}
                        pending={resolving}
                    />
                )}
                {presence.editors.length > 0 && (
                    <p aria-live="polite" className="bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
                        {canWrite
                            ? t`${editorNames} is editing this page. If you both change the same version, the second save is stopped and asked what to do.`
                            : t`${editorNames} is editing this page.`}
                    </p>
                )}
                {!canWrite && (
                    <p className="bg-muted text-muted-foreground px-4 py-1.5 text-xs" role="note">
                        {canComment ? t`You can comment on this page but not edit it.` : t`You can view this page but not edit it.`}
                    </p>
                )}
                <div className="px-6 pt-6">
                    <label className="sr-only" htmlFor={titleId}>
                        {t`Page title`}
                    </label>
                    <input
                        className="w-full bg-transparent text-3xl font-bold outline-none placeholder:opacity-40"
                        id={titleId}
                        maxLength={200}
                        onBlur={commitTitle}
                        onChange={(event) => setTitle(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.currentTarget.blur();
                            }
                        }}
                        placeholder={t`Untitled`}
                        readOnly={!canWrite}
                        value={title ?? page.title}
                    />
                </div>
                <div className="min-h-0 flex-1">
                    <PageEditor
                        content={page.content}
                        contentJson={page.contentJson as JSONContent | undefined}
                        editable={canWrite}
                        editorRef={editorRef}
                        key={pageId}
                        onSave={handleSave}
                    />
                </div>
            </div>
            {panel && (
                <aside className="w-80 shrink-0 border-l">
                    {panel === "draft" && keptDraft !== null && (
                        <PageKeptDraft
                            markdown={keptDraft}
                            onDismiss={() => {
                                setKeptDraft(null);
                                setPanel(null);
                            }}
                        />
                    )}
                    {panel === "comments" && (
                        <PageCommentsPanel
                            canComment={canComment}
                            canModerate={canManage}
                            draft={draft}
                            onCancelDraft={handleCancelDraft}
                            onDeleted={handleCommentDeleted}
                            onFocusAnchor={(commentId) => {
                                const editor = editorRef.current?.editor;

                                return editor ? focusCommentAnchor(editor, commentId) : false;
                            }}
                            onSubmitDraft={handleSubmitDraft}
                            pageId={pageId}
                        />
                    )}
                    {panel === "history" && (
                        <PageVersionPanel canRestore={canWrite} currentJson={() => editorRef.current?.getJSON()} onRestore={handleRestore} pageId={pageId} />
                    )}
                </aside>
            )}
            <PageAgentDialog
                currentJson={() => editorRef.current?.getJSON()}
                markdownToJSON={(markdown) => editorRef.current?.markdownToJSON(markdown) ?? null}
                onApply={async ({ json, markdown }) => {
                    try {
                        const result = await saveContentAsync({
                            baseRevision: baseRevisionRef.current ?? 0,
                            content: markdown,
                            contentJson: json,
                            pageId: pageId as never,
                            reason: "agent",
                        });

                        adoptRevision(result.revision);
                        applyJson(result.contentJson ?? json);
                    } catch (applyError) {
                        // Stale: the banner offers overwrite (with the proposal) or reload.
                        if (!reportConflict(applyError, "agent", { json, markdown })) {
                            throw applyError;
                        }
                    }
                }}
                onClose={() => setAgentOpen(false)}
                open={agentOpen}
                pageId={pageId}
            />
            {canManage && <PageShareDialog onClose={() => setShareOpen(false)} open={shareOpen} pageId={pageId} />}
        </div>
    );
};

export default PageView;
