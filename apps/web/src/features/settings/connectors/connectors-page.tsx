"use client";

import { useLingui } from "@lingui/react/macro";
import { Card } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { Search } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import SettingsCardHeader from "@/components/settings/settings-card-header";

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
        <Card className="w-full text-start" variant="plain">
            <SettingsCardHeader
                className="px-1"
                description={t`Connectors talk to each provider's own MCP server over OAuth 2.0. Your tokens are stored encrypted, the AI asks before using a tool that can change data, and disconnecting revokes access.`}
                title={t`Connectors`}
            />

            <div className="space-y-3">
                <p aria-live="polite" className="text-sm font-medium" role="status">
                    {!isLoading && connectedCount > 0 && t`${connectedCount} connected`}
                </p>

                <div className="relative">
                    <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2" />
                    <Input
                        aria-label={t`Search connectors`}
                        className="pl-10"
                        onChange={(event) => setSearchTerm(event.target.value)}
                        placeholder={t`Search connectors...`}
                        type="search"
                        value={searchTerm}
                    />
                </div>
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
                <TabsContent value={activeTab}>
                    {isLoading && (
                        <p className="text-muted-foreground py-6 text-center text-sm" role="status">
                            {t`Loading connectors...`}
                        </p>
                    )}
                    {!isLoading && filtered.length > 0 && (
                        <div className="surface-raised overflow-hidden rounded-xl" data-slot="settings-card-body">
                            <div className="px-4 py-1">
                                {filtered.map((entry) => (
                                    <ConnectorCard entry={entry} key={entry.id} />
                                ))}
                            </div>
                        </div>
                    )}
                    {!isLoading && filtered.length === 0 && (
                        <p className="text-muted-foreground py-6 text-center text-sm">
                            {searchTerm ? t`No connectors found for "${searchTerm}"` : t`No connectors available in this category`}
                        </p>
                    )}
                </TabsContent>
            </Tabs>
        </Card>
    );
};

export default ConnectorsPage;
