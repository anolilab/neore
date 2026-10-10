"use client";

import { useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { AlertCircle, Plug, Search } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import ConnectorCard from "./connector-card";
import connectorCategoryLabel from "./connector-category";
import { useConnectorCatalogForUser } from "./hooks/use-connector-catalog";

const ConnectorsPage: FC = () => {
    const { i18n, t } = useLingui();
    const [searchTerm, setSearchTerm] = useState("");
    const [activeTab, setActiveTab] = useState("all");

    const { data: catalog, isLoading } = useConnectorCatalogForUser();

    // The catalogue is a handful of rows, so search is a client-side filter.
    const query = searchTerm.trim().toLowerCase();
    const filtered = (catalog ?? []).filter(
        (entry) =>
            (activeTab === "all" || entry.category === activeTab) &&
            (!query || entry.name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query)),
    );
    const categories = [...new Set((catalog ?? []).map((entry) => entry.category))];
    const connectedCount = (catalog ?? []).filter((entry) => entry.connection?.status === "connected").length;

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="pb-4">
                    <div className="flex items-center gap-2">
                        <Plug aria-hidden className="size-5" />
                        <div>
                            <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`Connectors`}</CardTitle>
                            <CardDescription className="text-muted-foreground mt-1 text-xs">
                                {t`Connect third-party services to extend AI capabilities with your data and tools.`}
                            </CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
                        <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        <p>
                            {t`Connectors talk to each provider's own MCP server over OAuth 2.0. Your tokens are stored encrypted, the AI asks before using a tool that can change data, and disconnecting revokes access.`}
                        </p>
                    </div>

                    <p aria-live="polite" className="text-sm font-medium" role="status">
                        {!isLoading && connectedCount > 0 && t`${connectedCount} connected`}
                    </p>

                    <div className="relative">
                        <Search aria-hidden className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                            aria-label={t`Search connectors`}
                            className="pl-10"
                            onChange={(event) => setSearchTerm(event.target.value)}
                            placeholder={t`Search connectors...`}
                            type="search"
                            value={searchTerm}
                        />
                    </div>

                    <Tabs onValueChange={setActiveTab} value={activeTab}>
                        <TabsList className="w-full">
                            <TabsTrigger className="flex-1" value="all">
                                {t`All`}
                            </TabsTrigger>
                            {categories.map((category) => (
                                <TabsTrigger className="flex-1 capitalize" key={category} value={category}>
                                    {connectorCategoryLabel(category, i18n)}
                                </TabsTrigger>
                            ))}
                        </TabsList>

                        <TabsContent className="mt-4" value={activeTab}>
                            {isLoading && (
                                <p className="text-muted-foreground py-8 text-center text-sm" role="status">
                                    {t`Loading connectors...`}
                                </p>
                            )}
                            {!isLoading && filtered.length > 0 && (
                                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                    {filtered.map((entry) => (
                                        <li className="flex" key={entry.id}>
                                            <div className="flex-1">
                                                <ConnectorCard entry={entry} />
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {!isLoading && filtered.length === 0 && (
                                <p className="text-muted-foreground py-8 text-center text-sm">
                                    {searchTerm ? t`No connectors found for "${searchTerm}"` : t`No connectors available in this category`}
                                </p>
                            )}
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>
        </div>
    );
};

export default ConnectorsPage;
