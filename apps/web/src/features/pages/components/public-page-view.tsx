"use client";

/**
 * The anonymous, read-only view behind `/p/$token`. Outside every app layout,
 * like the shared-thread page: no guest session, no sidebar, nothing that
 * writes. The document arrives with comment marks already stripped
 * (`pages_sharing.getPublicPage`) and is drawn by a non-editable TipTap
 * instance with the canvas extension set — lazy, so the landing chunk stays
 * small.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@neore/ui/components/empty";
import { Link } from "@tanstack/react-router";
import type { JSONContent } from "@tiptap/core";
import { LinkIcon } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense } from "react";

import env from "@/lib/env";

const PublicPageContent = lazy(() => import("./public-page-content"));

export interface PublicPage {
    contentJson?: unknown;
    icon: string | null;
    title: string;
    updatedAt: number;
}

const PublicPageView: FC<{ page: PublicPage | null; status: "error" | "ok" | "unavailable" }> = ({ page, status }) => {
    const { i18n, t } = useLingui();
    const appTitle = env.VITE_APP_TITLE ?? "Neore Chat";

    return (
        <div className="min-h-dvh">
            <header className="bg-background/90 sticky top-0 z-10 border-b backdrop-blur">
                <div className="mx-auto flex h-14 max-w-3xl items-center px-4">
                    <Link className="text-sm font-semibold" to="/">
                        {appTitle}
                    </Link>
                </div>
            </header>
            <main className="mx-auto max-w-3xl px-4 py-10">
                {status === "ok" && page ? (
                    <article>
                        <h1 className="mb-2 text-3xl font-bold">
                            {page.icon && (
                                <span aria-hidden="true" className="mr-2">
                                    {page.icon}
                                </span>
                            )}
                            {page.title || t`Untitled`}
                        </h1>
                        <p className="text-muted-foreground mb-8 text-xs">
                            <Trans>
                                Last updated{" "}
                                <time dateTime={new Date(page.updatedAt).toISOString()}>
                                    {new Intl.DateTimeFormat(i18n.locale, { dateStyle: "long" }).format(page.updatedAt)}
                                </time>
                            </Trans>
                        </p>
                        <Suspense
                            fallback={
                                <p className="text-muted-foreground text-sm" role="status">
                                    {t`Loading…`}
                                </p>
                            }
                        >
                            <PublicPageContent content={(page.contentJson as JSONContent | undefined) ?? { content: [], type: "doc" }} />
                        </Suspense>
                    </article>
                ) : (
                    <Empty className="py-24">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <LinkIcon aria-hidden="true" />
                            </EmptyMedia>
                            <EmptyTitle>
                                <h1>{status === "error" ? <Trans>This page could not be loaded</Trans> : <Trans>This page is not available</Trans>}</h1>
                            </EmptyTitle>
                            <EmptyDescription>
                                {status === "error" ? (
                                    <Trans>Something went wrong on our side. Please try again in a moment.</Trans>
                                ) : (
                                    <Trans>The link may be wrong, or its owner has unpublished or deleted the page.</Trans>
                                )}
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                )}
            </main>
        </div>
    );
};

export default PublicPageView;
