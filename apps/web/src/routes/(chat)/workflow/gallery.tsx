import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { ArrowLeft, Image, Mic, Monitor, Search, Sparkles, Type, Video, Workflow } from "lucide-react";
import { useState } from "react";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import { GalleryCard } from "@/features/workflow/components/gallery";
import type { GalleryCategory, GallerySortOption, GalleryWorkflow } from "@/features/workflow/hooks/use-gallery";
import { useFeaturedWorkflows, useGalleryWorkflows } from "@/features/workflow/hooks/use-gallery";

const CATEGORY_TABS = [
    { value: "all", label: msg`All`, icon: Workflow },
    { value: "image", label: msg`Image`, icon: Image },
    { value: "text", label: msg`Text`, icon: Type },
    { value: "video", label: msg`Video`, icon: Video },
    { value: "audio", label: msg`Audio`, icon: Mic },
    { value: "automation", label: msg`Automation`, icon: Monitor },
] as const satisfies ReadonlyArray<{ icon: unknown; label: MessageDescriptor; value: string }>;

const SORT_OPTIONS = [
    { value: "recent", label: msg`Most Recent` },
    { value: "popular", label: msg`Most Popular` },
    { value: "most-forked", label: msg`Most Forked` },
] as const satisfies ReadonlyArray<{ label: MessageDescriptor; value: GallerySortOption }>;

const GalleryPage = () => {
    const route = "/(chat)/workflow/gallery";
    const navigate = useNavigate();
    const { i18n, t } = useLingui();

    const [activeCategory, setActiveCategory] = useState<string>("all");
    const [sortBy, setSortBy] = useState<GallerySortOption>("recent");
    const [searchQuery, setSearchQuery] = useState("");

    const category = activeCategory === "all" ? undefined : (activeCategory as GalleryCategory);

    const { workflows, isLoading } = useGalleryWorkflows({ category, sort: sortBy });
    const { featured } = useFeaturedWorkflows();

    // Filter by search query locally
    const searchTerm = searchQuery.trim().toLowerCase();
    const filteredWorkflows = searchTerm
        ? workflows.filter(
              (w) =>
                  w.title.toLowerCase().includes(searchTerm) ||
                  w.description?.toLowerCase().includes(searchTerm) ||
                  w.galleryTags.some((tag) => tag.toLowerCase().includes(searchTerm)),
          )
        : workflows;

    const handleWorkflowClick = (workflow: GalleryWorkflow) => {
        if (workflow.publicAccessToken) {
            navigate({
                to: "/workflow/shared/$token",
                params: { token: workflow.publicAccessToken },
            });
        }
    };

    const workflowGrid =
        filteredWorkflows.length === 0 ? (
            <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-12">
                    <Workflow className="text-muted-foreground mb-4 size-12" />
                    <h3 className="mb-2 text-lg font-medium">
                        <Trans>No workflows found</Trans>
                    </h3>
                    <p className="text-muted-foreground text-center">
                        {searchQuery ? <Trans>Try adjusting your search terms.</Trans> : <Trans>No community workflows in this category yet.</Trans>}
                    </p>
                </CardContent>
            </Card>
        ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredWorkflows.map((workflow) => (
                    <GalleryCard key={workflow._id} onClick={handleWorkflowClick} workflow={workflow} />
                ))}
            </div>
        );

    return (
        <RouteErrorBoundary routeName={route}>
            <ScrollArea className="h-full">
                <div className="container mx-auto max-w-6xl py-8">
                    {/* Header */}
                    <div className="mb-8 flex items-center gap-4">
                        <Button aria-label={t`Back to workflows`} onClick={() => navigate({ to: "/workflow" })} size="icon" variant="ghost">
                            <ArrowLeft className="size-4" />
                        </Button>
                        <div className="flex-1">
                            <h1 className="text-2xl font-bold">
                                <Trans>Community Gallery</Trans>
                            </h1>
                            <p className="text-muted-foreground">
                                <Trans>Browse, fork, and remix workflows shared by the community</Trans>
                            </p>
                        </div>
                    </div>

                    {/* Featured Section */}
                    {featured.length > 0 && (
                        <div className="mb-8">
                            <div className="mb-4 flex items-center gap-2">
                                <Sparkles className="size-4 text-amber-500" />
                                <h2 className="text-lg font-semibold">
                                    <Trans>Featured</Trans>
                                </h2>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {featured.slice(0, 3).map((workflow) => (
                                    <GalleryCard key={workflow._id} onClick={handleWorkflowClick} workflow={workflow} />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Search and Filter Bar */}
                    <div className="mb-6 flex items-center gap-3">
                        <div className="relative max-w-sm flex-1">
                            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                            <Input className="pl-9" onChange={(e) => setSearchQuery(e.target.value)} placeholder={t`Search workflows...`} value={searchQuery} />
                        </div>
                        <Select onValueChange={(v) => setSortBy(v as GallerySortOption)} value={sortBy}>
                            <SelectTrigger className="w-40">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SORT_OPTIONS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                        {i18n._(option.label)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Category Tabs + Workflow Grid */}
                    <Tabs onValueChange={setActiveCategory} value={activeCategory}>
                        <TabsList className="mb-6">
                            {CATEGORY_TABS.map((tab) => (
                                <TabsTrigger className="gap-1.5" key={tab.value} value={tab.value}>
                                    <tab.icon className="size-3.5" />
                                    {i18n._(tab.label)}
                                </TabsTrigger>
                            ))}
                        </TabsList>

                        <TabsContent className="mt-0" value={activeCategory}>
                            {isLoading ? (
                                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                    {[1, 2, 3, 4, 5, 6].map((i) => (
                                        <Card className="animate-pulse" key={i}>
                                            <CardContent className="h-36" />
                                        </Card>
                                    ))}
                                </div>
                            ) : (
                                workflowGrid
                            )}
                        </TabsContent>
                    </Tabs>
                </div>
            </ScrollArea>
        </RouteErrorBoundary>
    );
};

export const Route = createFileRoute("/(chat)/workflow/gallery")({
    component: GalleryPage,
    ssr: false,
});
