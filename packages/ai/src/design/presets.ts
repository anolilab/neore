/**
 * Platform presets for design canvas — standard dimensions for social media, marketing, web, and print.
 * 37 presets across 5 categories, matching Suna's coverage.
 */

export interface DesignPreset {
    category: "social" | "marketing" | "print" | "web" | "custom";
    description: string;
    height: number;
    id: string;
    name: string;
    platform?: string;
    width: number;
}

export const DESIGN_PRESETS: DesignPreset[] = [
    // Social Media (17)
    { category: "social", description: "Square post", height: 1080, id: "ig-post", name: "Instagram Post", platform: "instagram", width: 1080 },
    { category: "social", description: "Vertical story/reel", height: 1920, id: "ig-story", name: "Instagram Story", platform: "instagram", width: 1080 },
    { category: "social", description: "Landscape post", height: 566, id: "ig-landscape", name: "Instagram Landscape", platform: "instagram", width: 1080 },
    { category: "social", description: "Link preview / shared image", height: 630, id: "fb-post", name: "Facebook Post", platform: "facebook", width: 1200 },
    { category: "social", description: "Profile cover photo", height: 312, id: "fb-cover", name: "Facebook Cover", platform: "facebook", width: 820 },
    { category: "social", description: "Vertical story", height: 1920, id: "fb-story", name: "Facebook Story", platform: "facebook", width: 1080 },
    { category: "social", description: "Timeline image", height: 675, id: "x-post", name: "X (Twitter) Post", platform: "twitter", width: 1200 },
    { category: "social", description: "Profile header", height: 500, id: "x-header", name: "X Header", platform: "twitter", width: 1500 },
    { category: "social", description: "Feed image", height: 627, id: "linkedin-post", name: "LinkedIn Post", platform: "linkedin", width: 1200 },
    { category: "social", description: "Profile background", height: 396, id: "linkedin-cover", name: "LinkedIn Cover", platform: "linkedin", width: 1584 },
    { category: "social", description: "Vertical video thumbnail", height: 1920, id: "tiktok-video", name: "TikTok Video", platform: "tiktok", width: 1080 },
    { category: "social", description: "Video thumbnail", height: 720, id: "youtube-thumb", name: "YouTube Thumbnail", platform: "youtube", width: 1280 },
    { category: "social", description: "Channel art", height: 1440, id: "youtube-banner", name: "YouTube Banner", platform: "youtube", width: 2560 },
    { category: "social", description: "Standard pin", height: 1500, id: "pinterest-pin", name: "Pinterest Pin", platform: "pinterest", width: 1000 },
    { category: "social", description: "Full-screen ad", height: 1920, id: "snapchat-ad", name: "Snapchat Ad", platform: "snapchat", width: 1080 },
    { category: "social", description: "Square post", height: 1080, id: "threads-post", name: "Threads Post", platform: "threads", width: 1080 },
    { category: "social", description: "Status image", height: 1920, id: "whatsapp-status", name: "WhatsApp Status", platform: "whatsapp", width: 1080 },

    // Marketing (10)
    { category: "marketing", description: "Email banner", height: 200, id: "email-header", name: "Email Header", width: 600 },
    { category: "marketing", description: "Hero image for newsletters", height: 400, id: "email-hero", name: "Email Hero", width: 600 },
    { category: "marketing", description: "Blog post featured image", height: 630, id: "blog-header", name: "Blog Header", width: 1200 },
    { category: "marketing", description: "Link preview image", height: 630, id: "og-image", name: "Open Graph Image", width: 1200 },
    { category: "marketing", description: "Standard ad banner", height: 90, id: "banner-leaderboard", name: "Leaderboard Banner", width: 728 },
    { category: "marketing", description: "Inline ad", height: 250, id: "banner-medium", name: "Medium Rectangle", width: 300 },
    { category: "marketing", description: "Sidebar ad", height: 600, id: "banner-skyscraper", name: "Wide Skyscraper", width: 160 },
    { category: "marketing", description: "A4 print flyer (300 DPI)", height: 3508, id: "flyer-a4", name: "A4 Flyer", width: 2480 },
    { category: "marketing", description: "US Letter print (300 DPI)", height: 3300, id: "flyer-letter", name: "US Letter Flyer", width: 2550 },
    { category: "marketing", description: "Standard business card (300 DPI)", height: 600, id: "business-card", name: "Business Card", width: 1050 },

    // Web (4)
    { category: "web", description: "Full-width hero section", height: 1080, id: "web-hero", name: "Website Hero", width: 1920 },
    { category: "web", description: "Wide promotional banner", height: 480, id: "web-banner", name: "Website Banner", width: 1920 },
    { category: "web", description: "Website icon", height: 512, id: "favicon", name: "Favicon", width: 512 },
    { category: "web", description: "Mobile app icon", height: 1024, id: "app-icon", name: "App Icon", width: 1024 },

    // Print (3)
    { category: "print", description: "Large poster (300 DPI)", height: 7200, id: "poster-18x24", name: "Poster 18×24", width: 5400 },
    { category: "print", description: "Standard postcard (300 DPI)", height: 1200, id: "postcard", name: "Postcard", width: 1800 },
    { category: "print", description: "Bookmark (300 DPI)", height: 1800, id: "bookmark", name: "Bookmark", width: 600 },

    // Custom (3)
    { category: "custom", description: "Custom square canvas", height: 1080, id: "custom-square", name: "Square", width: 1080 },
    { category: "custom", description: "Custom 16:9 canvas", height: 1080, id: "custom-landscape", name: "Landscape", width: 1920 },
    { category: "custom", description: "Custom 9:16 canvas", height: 1920, id: "custom-portrait", name: "Portrait", width: 1080 },
];

/** Look up a preset by ID. Returns undefined if not found. */
export const getDesignPreset = (id: string): DesignPreset | undefined => DESIGN_PRESETS.find((p) => p.id === id);

/** Get all presets in a given category. */
export const getPresetsByCategory = (category: DesignPreset["category"]): DesignPreset[] => DESIGN_PRESETS.filter((p) => p.category === category);

/** All preset IDs (for validation). */
export const DESIGN_PRESET_IDS = DESIGN_PRESETS.map((p) => p.id);
