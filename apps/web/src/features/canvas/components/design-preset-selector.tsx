"use client";

/**
 * DesignPresetSelector — Dialog for choosing canvas dimensions from platform presets
 * or entering custom dimensions when creating a new design via chat.
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { AppWindowIcon, GlobeIcon, MegaphoneIcon, MonitorIcon, PrinterIcon } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Preset data (inline to avoid importing @neore/ai in the web bundle)
// ---------------------------------------------------------------------------

interface PresetItem {
    description: MessageDescriptor;
    height: number;
    id: string;
    name: MessageDescriptor;
    width: number;
}

interface PresetCategory {
    icon: FC<{ className?: string }>;
    id: string;
    label: MessageDescriptor;
    presets: PresetItem[];
}

const CATEGORIES: PresetCategory[] = [
    {
        icon: GlobeIcon,
        id: "social",
        label: msg`Social Media`,
        presets: [
            { description: msg`Square post`, height: 1080, id: "ig-post", name: msg`Instagram Post`, width: 1080 },
            { description: msg`Vertical story`, height: 1920, id: "ig-story", name: msg`Instagram Story`, width: 1080 },
            { description: msg`Link preview`, height: 630, id: "fb-post", name: msg`Facebook Post`, width: 1200 },
            { description: msg`Timeline image`, height: 675, id: "x-post", name: msg`X (Twitter) Post`, width: 1200 },
            { description: msg`Feed image`, height: 627, id: "linkedin-post", name: msg`LinkedIn Post`, width: 1200 },
            { description: msg`Video thumbnail`, height: 720, id: "youtube-thumb", name: msg`YouTube Thumbnail`, width: 1280 },
            { description: msg`Standard pin`, height: 1500, id: "pinterest-pin", name: msg`Pinterest Pin`, width: 1000 },
            { description: msg`Vertical video`, height: 1920, id: "tiktok-video", name: msg`TikTok Video`, width: 1080 },
        ],
    },
    {
        icon: MegaphoneIcon,
        id: "marketing",
        label: msg`Marketing`,
        presets: [
            { description: msg`Link preview`, height: 630, id: "og-image", name: msg`Open Graph Image`, width: 1200 },
            { description: msg`Featured image`, height: 630, id: "blog-header", name: msg`Blog Header`, width: 1200 },
            { description: msg`Email banner`, height: 200, id: "email-header", name: msg`Email Header`, width: 600 },
            { description: msg`Newsletter hero`, height: 400, id: "email-hero", name: msg`Email Hero`, width: 600 },
            { description: msg`Standard card`, height: 600, id: "business-card", name: msg`Business Card`, width: 1050 },
        ],
    },
    {
        icon: MonitorIcon,
        id: "web",
        label: msg`Web`,
        presets: [
            { description: msg`Full-width hero`, height: 1080, id: "web-hero", name: msg`Website Hero`, width: 1920 },
            { description: msg`Wide banner`, height: 480, id: "web-banner", name: msg`Website Banner`, width: 1920 },
            { description: msg`Website icon`, height: 512, id: "favicon", name: msg`Favicon`, width: 512 },
            { description: msg`Mobile app icon`, height: 1024, id: "app-icon", name: msg`App Icon`, width: 1024 },
        ],
    },
    {
        icon: PrinterIcon,
        id: "print",
        label: msg`Print`,
        presets: [
            { description: msg`300 DPI`, height: 3508, id: "flyer-a4", name: msg`A4 Flyer`, width: 2480 },
            { description: msg`Large poster`, height: 7200, id: "poster-18x24", name: msg`Poster 18x24`, width: 5400 },
            { description: msg`Standard postcard`, height: 1200, id: "postcard", name: msg`Postcard`, width: 1800 },
        ],
    },
    {
        icon: AppWindowIcon,
        id: "custom",
        label: msg`Custom`,
        presets: [
            { description: msg`1:1 ratio`, height: 1080, id: "custom-square", name: msg`Square`, width: 1080 },
            { description: msg`16:9 ratio`, height: 1080, id: "custom-landscape", name: msg`Landscape`, width: 1920 },
            { description: msg`9:16 ratio`, height: 1920, id: "custom-portrait", name: msg`Portrait`, width: 1080 },
        ],
    },
];

// ---------------------------------------------------------------------------
// Template data
// ---------------------------------------------------------------------------

interface TemplateItem {
    category: string;
    description: MessageDescriptor;
    height: number;
    id: string;
    name: MessageDescriptor;
    presetId: string;
    width: number;
}

const TEMPLATES: TemplateItem[] = [
    {
        category: "social",
        description: msg`Bold centered text`,
        height: 1080,
        id: "social-announcement",
        name: msg`Social Announcement`,
        presetId: "ig-post",
        width: 1080,
    },
    {
        category: "social",
        description: msg`Elegant quote with attribution`,
        height: 1080,
        id: "social-quote",
        name: msg`Quote Card`,
        presetId: "ig-post",
        width: 1080,
    },
    {
        category: "social",
        description: msg`Vertical promo layout`,
        height: 1920,
        id: "social-story-promo",
        name: msg`Story Promo`,
        presetId: "ig-story",
        width: 1080,
    },
    {
        category: "marketing",
        description: msg`Full-width promotional`,
        height: 480,
        id: "marketing-banner",
        name: msg`Web Banner`,
        presetId: "web-banner",
        width: 1920,
    },
    {
        category: "marketing",
        description: msg`Newsletter hero image`,
        height: 400,
        id: "marketing-email-hero",
        name: msg`Email Hero`,
        presetId: "email-hero",
        width: 600,
    },
    {
        category: "presentation",
        description: msg`Clean title slide`,
        height: 1080,
        id: "presentation-title",
        name: msg`Title Slide`,
        presetId: "custom-landscape",
        width: 1920,
    },
    {
        category: "presentation",
        description: msg`Heading and bullets`,
        height: 1080,
        id: "presentation-content",
        name: msg`Content Slide`,
        presetId: "custom-landscape",
        width: 1920,
    },
    {
        category: "minimal",
        description: msg`Simple centered card`,
        height: 630,
        id: "minimal-card",
        name: msg`Minimal Card`,
        presetId: "og-image",
        width: 1200,
    },
    {
        category: "minimal",
        description: msg`Modern gradient background`,
        height: 630,
        id: "minimal-gradient",
        name: msg`Gradient Card`,
        presetId: "og-image",
        width: 1200,
    },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DesignPresetSelectorProps {
    className?: string;
    onSelectPreset: (presetId: string, width: number, height: number) => void;
    onSelectTemplate: (templateId: string) => void;
}

const DesignPresetSelector: FC<DesignPresetSelectorProps> = ({ className, onSelectPreset, onSelectTemplate }) => {
    const { i18n, t } = useLingui();
    const [activeTab, setActiveTab] = useState<"presets" | "templates">("presets");
    const [activeCategory, setActiveCategory] = useState("social");

    const currentCategory = CATEGORIES.find((c) => c.id === activeCategory) ?? CATEGORIES[0];

    const handlePresetClick = (preset: PresetItem) => {
        onSelectPreset(preset.id, preset.width, preset.height);
    };

    return (
        <div className={cn("flex flex-col", className)}>
            {/* Tab bar */}
            <div className="flex border-b">
                <button
                    className={`px-4 py-2 text-sm font-medium transition-colors ${activeTab === "presets" ? "border-primary text-primary border-b-2" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => setActiveTab("presets")}
                    type="button"
                >
                    {t`Presets`}
                </button>
                <button
                    className={`px-4 py-2 text-sm font-medium transition-colors ${activeTab === "templates" ? "border-primary text-primary border-b-2" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => setActiveTab("templates")}
                    type="button"
                >
                    {t`Templates`}
                </button>
            </div>

            {activeTab === "presets" ? (
                <div className="flex flex-1" style={{ minHeight: 0 }}>
                    {/* Category sidebar */}
                    <div className="flex w-36 flex-col gap-0.5 border-r p-2">
                        {CATEGORIES.map((cat) => (
                            <button
                                className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                                    activeCategory === cat.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
                                }`}
                                key={cat.id}
                                onClick={() => setActiveCategory(cat.id)}
                                type="button"
                            >
                                <cat.icon className="size-4 shrink-0" />
                                <span>{i18n._(cat.label)}</span>
                            </button>
                        ))}
                    </div>

                    {/* Preset grid */}
                    <div className="flex-1 overflow-y-auto p-3">
                        <div className="grid grid-cols-2 gap-2">
                            {currentCategory?.presets.map((preset) => {
                                const aspectRatio = preset.width / preset.height;
                                const previewW = aspectRatio >= 1 ? 80 : 80 * aspectRatio;
                                const previewH = aspectRatio >= 1 ? 80 / aspectRatio : 80;

                                return (
                                    <button
                                        className="hover:border-primary flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors"
                                        key={preset.id}
                                        onClick={() => handlePresetClick(preset)}
                                        type="button"
                                    >
                                        <div className="bg-muted rounded border" style={{ height: previewH, width: previewW }} />
                                        <div className="text-center">
                                            <p className="text-sm font-medium">{i18n._(preset.name)}</p>
                                            <p className="text-muted-foreground text-xs">
                                                {preset.width} x {preset.height}
                                            </p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            ) : (
                /* Template gallery */
                <div className="flex-1 overflow-y-auto p-3">
                    <div className="grid grid-cols-2 gap-3">
                        {TEMPLATES.map((template) => (
                            <button
                                className="hover:border-primary flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors"
                                key={template.id}
                                onClick={() => onSelectTemplate(template.id)}
                                type="button"
                            >
                                <div
                                    className="bg-muted/50 w-full rounded"
                                    style={{
                                        aspectRatio: `${template.width}/${template.height}`,
                                        maxHeight: 100,
                                    }}
                                />
                                <div>
                                    <p className="text-sm font-medium">{i18n._(template.name)}</p>
                                    <p className="text-muted-foreground text-xs">{i18n._(template.description)}</p>
                                    <p className="text-muted-foreground mt-0.5 text-xs">
                                        {template.width} x {template.height}
                                    </p>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default DesignPresetSelector;
