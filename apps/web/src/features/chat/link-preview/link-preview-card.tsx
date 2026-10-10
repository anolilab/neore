"use client";

/**
 * One compact preview card for a URL. Fetches nothing until it scrolls near the
 * viewport, and keeps ONE fixed height through every state (placeholder,
 * loaded, failed) so a card never pushes the thread around: a URL with no
 * preview still renders as a plain host + path card.
 */
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import cn from "@neore/ui/utils/cn";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { useQuery } from "@tanstack/react-query";
import { CircleDotIcon, GitMergeIcon, GitPullRequestIcon, LinkIcon, StarIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

import { createLunoraActionQueryOptions, useLunora } from "@/lib/lunora/crpc";
import { LIVE_META_KEY } from "@/lib/lunora/live-queries";

/** Start loading a little before the card is on screen. */
const ROOT_MARGIN = "200px 0px";

const HOUR_MS = 60 * 60 * 1000;

const WWW_PREFIX_RE = /^www\./u;
const TRAILING_SLASH_RE = /\/$/u;

const STATE_COLORS: Record<string, string> = {
    merged: "text-purple-600 dark:text-purple-400",
    open: "text-green-600 dark:text-green-400",
};

const useNearViewport = (): [React.RefObject<HTMLAnchorElement | null>, boolean] => {
    const ref = useRef<HTMLAnchorElement | null>(null);
    const [isNear, setIsNear] = useState(false);

    useEffect(() => {
        const element = ref.current;

        if (isNear || !element) {
            return undefined;
        }

        if (typeof IntersectionObserver === "undefined") {
            setIsNear(true);

            return undefined;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.every((entry) => !entry.isIntersecting)) {
                    return;
                }

                setIsNear(true);
                observer.disconnect();
            },
            { rootMargin: ROOT_MARGIN },
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [isNear]);

    return [ref, isNear];
};

const splitUrl = (url: string): { host: string; path: string } => {
    try {
        const parsed = new URL(url);

        return { host: parsed.hostname.replace(WWW_PREFIX_RE, ""), path: `${parsed.pathname}${parsed.search}`.replace(TRAILING_SLASH_RE, "") };
    } catch {
        return { host: url, path: "" };
    }
};

const GithubStateIcon: FC<{ kind: string; state?: string }> = ({ kind, state }) => {
    const color = (state === undefined ? undefined : STATE_COLORS[state]) ?? "text-muted-foreground";

    if (state === "merged") {
        return <GitMergeIcon aria-hidden="true" className={cn("size-3.5 shrink-0", color)} />;
    }

    return kind === "github-pull" ? (
        <GitPullRequestIcon aria-hidden="true" className={cn("size-3.5 shrink-0", color)} />
    ) : (
        <CircleDotIcon aria-hidden="true" className={cn("size-3.5 shrink-0", color)} />
    );
};

const LinkPreviewCard: FC<{ url: string }> = ({ url }) => {
    const { i18n, t } = useLingui();
    const client = useLunora();
    const [ref, isNear] = useNearViewport();
    const [hideFavicon, setHideFavicon] = useState(false);
    const [hideImage, setHideImage] = useState(false);

    const { data } = useQuery({
        ...createLunoraActionQueryOptions(client, api.chat.link_preview.getLinkPreview, { url }),
        enabled: isNear,
        gcTime: HOUR_MS,
        // An action has no subscription; say so for the live-query manager too.
        meta: { [LIVE_META_KEY]: false },
        retry: false,
        staleTime: HOUR_MS,
    });

    const { host, path } = splitUrl(url);
    const preview = data?.ok ? data : undefined;
    const github = preview?.github;
    const title = preview?.title ?? (preview?.linear ? preview.linear.identifier : `${host}${path}`);
    const siteName = preview?.siteName ?? host;
    const stateLabels: Record<string, string> = { closed: t`Closed`, draft: t`Draft`, merged: t`Merged`, open: t`Open` };
    const stateLabel = github?.state === undefined ? undefined : stateLabels[github.state];

    let detail: string | undefined = preview?.description;

    if (preview?.kind === "linear-issue" && preview.linear) {
        detail = t`Linear issue ${preview.linear.identifier}`;
    } else if (github && github.number !== undefined) {
        detail = [`${github.owner}/${github.repo}#${String(github.number)}`, stateLabel].filter(Boolean).join(" · ");
    }

    const showImage = preview?.kind === "generic" && preview.image !== undefined && !hideImage;

    return (
        <a
            aria-label={t`${title} on ${siteName} (opens in a new tab)`}
            className="not-prose bg-card hover:bg-accent/50 focus-visible:ring-ring flex h-[4.5rem] w-full max-w-md items-stretch overflow-hidden rounded-lg border text-left no-underline transition-colors focus-visible:ring-2 focus-visible:outline-none"
            href={url}
            ref={ref}
            rel="noopener noreferrer"
            target="_blank"
        >
            <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-2">
                <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                    {preview?.favicon && !hideFavicon ? (
                        <img
                            alt=""
                            className="size-3.5 shrink-0 rounded-sm"
                            decoding="async"
                            height={14}
                            loading="lazy"
                            onError={() => setHideFavicon(true)}
                            referrerPolicy="no-referrer"
                            src={preview.favicon}
                            width={14}
                        />
                    ) : (
                        <LinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{siteName}</span>
                    {github?.stars !== undefined && (
                        <span className="flex shrink-0 items-center gap-0.5">
                            <StarIcon aria-hidden="true" className="size-3" />
                            {formatNumber(github.stars, i18n.locale)}
                        </span>
                    )}
                    {github?.language && <span className="shrink-0">{github.language}</span>}
                </span>
                <span className="text-foreground flex min-w-0 items-center gap-1.5 text-sm font-medium">
                    {github?.number !== undefined && <GithubStateIcon kind={preview?.kind ?? ""} state={github.state} />}
                    <span className="truncate">{title}</span>
                </span>
                <span className={cn("text-muted-foreground truncate text-xs", !detail && "invisible")}>{detail ?? "—"}</span>
            </span>
            {showImage && (
                <img
                    alt=""
                    className="bg-muted h-full w-[4.5rem] shrink-0 object-cover"
                    decoding="async"
                    loading="lazy"
                    onError={() => setHideImage(true)}
                    referrerPolicy="no-referrer"
                    src={preview.image}
                />
            )}
        </a>
    );
};

export default LinkPreviewCard;
