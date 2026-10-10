"use client";

import { useLingui } from "@lingui/react/macro";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { Store, Zap } from "lucide-react";
import { useState } from "react";

import SkillHeader from "./skill-header";
import SkillList from "./skill-list";
import SkillMarketplace from "./skill-marketplace";

/**
 * The /skills page: the user's own skills and the public marketplace, side by side.
 */
const SkillsPage = () => {
    const { t } = useLingui();
    const [tab, setTab] = useState<"marketplace" | "mine">("mine");
    // A fork from the marketplace lands in "My skills"; bumping this refetches it.
    const [reloadKey, setReloadKey] = useState(0);

    return (
        <div className="space-y-6">
            <SkillHeader />
            <Tabs onValueChange={(value) => setTab(value === "marketplace" ? "marketplace" : "mine")} value={tab}>
                <TabsList aria-label={t`Skills views`} className="w-full max-w-sm">
                    <TabsTrigger value="mine">
                        <Zap aria-hidden="true" />
                        {t`My skills`}
                    </TabsTrigger>
                    <TabsTrigger value="marketplace">
                        <Store aria-hidden="true" />
                        {t`Marketplace`}
                    </TabsTrigger>
                </TabsList>
                <TabsContent className="pt-4 text-sm" value="mine">
                    <SkillList reloadKey={reloadKey} />
                </TabsContent>
                <TabsContent className="pt-4 text-sm" value="marketplace">
                    <SkillMarketplace
                        onForked={() => {
                            setReloadKey((key) => key + 1);
                            setTab("mine");
                        }}
                    />
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default SkillsPage;
