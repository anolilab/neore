"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, Star, Store, Zap } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { formatRating, MARKETPLACE_PAGE_SIZE, SEARCH_DEBOUNCE_MS } from "../lib/marketplace";
import { SKILL_CATEGORIES } from "../lib/skill-form";
import MarketplaceSkillDetailDialog from "./marketplace-skill-detail-dialog";

const ALL_CATEGORIES = "__all__";

interface MarketplaceSkillSummary {
    _id: Id<"skills">;
    category?: string;
    description: string;
    icon?: string;
    name: string;
    rating: number;
    ratingCount: number;
    slug: string;
    tags?: string[];
    usageCount: number;
}

interface SkillMarketplaceProps {
    /** A fork lands in the user's own list, which the parent reloads. */
    onForked?: () => void;
}

const useDebouncedValue = <T,>(value: T, delay: number): T => {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = setTimeout(setDebounced, delay, value);

        return () => clearTimeout(timer);
    }, [value, delay]);

    return debounced;
};

const MarketplaceCard = ({ onOpen, skill }: { onOpen: (id: Id<"skills">) => void; skill: MarketplaceSkillSummary }) => {
    const { t } = useLingui();

    return (
        <li>
            <Card className="focus-within:ring-ring relative h-full transition-shadow focus-within:shadow-md focus-within:ring-2 hover:shadow-md">
                <CardHeader className="space-y-2 pb-3">
                    <div className="flex items-center gap-2">
                        <div aria-hidden="true" className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md">
                            {skill.icon || <Zap className="size-4" />}
                        </div>
                        <div className="min-w-0">
                            <CardTitle className="truncate text-base">
                                {/* The whole card is clickable via this button's stretched hit area. */}
                                <button
                                    className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                                    onClick={() => onOpen(skill._id)}
                                    type="button"
                                >
                                    {skill.name}
                                </button>
                            </CardTitle>
                            <code className="text-muted-foreground text-xs">/{skill.slug}</code>
                        </div>
                    </div>
                    <CardDescription className="line-clamp-2 text-sm">{skill.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2 pt-0 text-xs">
                    {skill.category && <Badge variant="secondary">{skill.category}</Badge>}
                    <span className="text-muted-foreground inline-flex items-center gap-1">
                        <Star aria-hidden="true" className="size-3 fill-amber-400 text-amber-400" />
                        {skill.ratingCount > 0 ? t`${formatRating(skill.rating)} (${skill.ratingCount})` : t`Not rated`}
                    </span>
                    <span className="text-muted-foreground">{t`${skill.usageCount} uses`}</span>
                </CardContent>
            </Card>
        </li>
    );
};

const SkillMarketplace = ({ onForked }: SkillMarketplaceProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const searchId = useId();
    const categoryLabelId = useId();
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<string>(ALL_CATEGORIES);
    const [limit, setLimit] = useState(MARKETPLACE_PAGE_SIZE);
    const [selectedSkillId, setSelectedSkillId] = useState<Id<"skills"> | null>(null);

    const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
    const isSearching = query.length > 0;
    const categoryFilter = category === ALL_CATEGORIES ? undefined : category;

    const browse = useQuery({
        ...crpc.skills.marketplace.browseSkills.queryOptions({ category: categoryFilter, limit }),
        enabled: !isSearching,
        placeholderData: keepPreviousData,
    });
    const searchResults = useQuery({
        ...crpc.skills.marketplace.searchSkills.queryOptions({ limit: MARKETPLACE_PAGE_SIZE, query }),
        enabled: isSearching,
    });

    const active = isSearching ? searchResults : browse;
    const rawSkills: MarketplaceSkillSummary[] | undefined = isSearching ? searchResults.data : browse.data?.skills;
    // Search has no category filter server-side; apply it here so the two controls compose.
    const skills = isSearching && categoryFilter ? rawSkills?.filter((skill) => skill.category === categoryFilter) : rawSkills;

    const categoryItems = [
        { label: t`All categories`, value: ALL_CATEGORIES },
        ...SKILL_CATEGORIES.map((value) => {
            return { label: value.charAt(0).toUpperCase() + value.slice(1), value };
        }),
    ];

    let statusText = "";

    if (active.isPending) {
        statusText = t`Loading skills…`;
    } else if (skills) {
        statusText = t`${plural(skills.length, { one: "# skill", other: "# skills" })}`;
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1">
                    <Label className="sr-only" htmlFor={searchId}>
                        {t`Search the marketplace`}
                    </Label>
                    <div className="relative">
                        <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                            className="pl-9"
                            id={searchId}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t`Search public skills…`}
                            type="search"
                            value={search}
                        />
                    </div>
                </div>
                <div className="space-y-1">
                    <span className="sr-only" id={categoryLabelId}>
                        {t`Category`}
                    </span>
                    <Select
                        items={categoryItems}
                        onValueChange={(value) => {
                            setCategory(value ? String(value) : ALL_CATEGORIES);
                            setLimit(MARKETPLACE_PAGE_SIZE);
                        }}
                        value={category}
                    >
                        <SelectTrigger aria-labelledby={categoryLabelId} className="w-48">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {categoryItems.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                    {item.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <p aria-live="polite" className="sr-only" role="status">
                {statusText}
            </p>

            {active.error && (
                <p className="text-destructive text-sm" role="alert">
                    {t`Could not load the marketplace. Try again later.`}
                </p>
            )}

            {active.isPending && (
                <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton className="h-36 w-full" key={index} />
                    ))}
                </div>
            )}

            {skills && skills.length === 0 && (
                <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center">
                    <Store aria-hidden="true" className="text-muted-foreground size-8" />
                    <p className="text-muted-foreground text-sm">
                        {isSearching ? t`No public skills match your search.` : t`No public skills yet. Publish one by setting a skill's visibility to Public.`}
                    </p>
                </div>
            )}

            {skills && skills.length > 0 && (
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {skills.map((skill) => (
                        <MarketplaceCard key={skill._id} onOpen={setSelectedSkillId} skill={skill} />
                    ))}
                </ul>
            )}

            {!isSearching && browse.data?.hasMore && (
                <div className="flex justify-center">
                    <Button
                        aria-busy={browse.isFetching}
                        disabled={browse.isFetching}
                        onClick={() => setLimit((current) => current + MARKETPLACE_PAGE_SIZE)}
                        variant="outline"
                    >
                        {t`Load more`}
                    </Button>
                </div>
            )}

            <MarketplaceSkillDetailDialog onClose={() => setSelectedSkillId(null)} onForked={onForked} skillId={selectedSkillId} />
        </div>
    );
};

export default SkillMarketplace;
