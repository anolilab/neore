/**
 * Design styles for AI-enhanced design generation.
 * 16 styles with prompt modifiers — each style appends design-aware context to the generation prompt.
 */

export interface DesignStyle {
    description: string;
    id: string;
    name: string;
    promptModifier: string;
}

export const DESIGN_STYLES: DesignStyle[] = [
    {
        description: "Clean, lots of whitespace, simple typography",
        id: "minimal",
        name: "Minimal",
        promptModifier: "minimalist design, clean layout, ample whitespace, simple typography, modern",
    },
    {
        description: "High contrast, large text, vibrant colors",
        id: "bold",
        name: "Bold",
        promptModifier: "bold design, high contrast, large impactful typography, vibrant saturated colors",
    },
    {
        description: "Sophisticated, serif fonts, muted palette",
        id: "elegant",
        name: "Elegant",
        promptModifier: "elegant sophisticated design, serif typography, muted refined color palette, luxury feel",
    },
    {
        description: "Fun, rounded shapes, bright palette",
        id: "playful",
        name: "Playful",
        promptModifier: "playful fun design, rounded shapes, bright cheerful colors, hand-drawn elements",
    },
    {
        description: "Professional, structured, brand-safe",
        id: "corporate",
        name: "Corporate",
        promptModifier: "professional corporate design, structured grid layout, business-appropriate, polished",
    },
    {
        description: "Vintage aesthetics, warm tones, textured",
        id: "retro",
        name: "Retro",
        promptModifier: "retro vintage design, warm nostalgic tones, textured paper feel, classic typography",
    },
    {
        description: "Dark backgrounds, glowing accents, cyberpunk",
        id: "neon",
        name: "Neon",
        promptModifier: "neon cyberpunk design, dark background, glowing neon accents, futuristic",
    },
    {
        description: "Natural shapes, earth tones, botanical",
        id: "organic",
        name: "Organic",
        promptModifier: "organic natural design, flowing shapes, earth tones, botanical elements, sustainable feel",
    },
    {
        description: "Raw, monospace, stark contrasts",
        id: "brutalist",
        name: "Brutalist",
        promptModifier: "brutalist design, raw unpolished aesthetic, monospace typography, stark black and white contrasts",
    },
    {
        description: "Smooth color transitions, modern, vibrant",
        id: "gradient",
        name: "Gradient",
        promptModifier: "modern gradient design, smooth color transitions, vibrant gradients, contemporary",
    },
    {
        description: "No shadows, solid colors, geometric",
        id: "flat",
        name: "Flat",
        promptModifier: "flat design, no shadows or depth, solid colors, geometric shapes, clean vectors",
    },
    {
        description: "Frosted glass effects, transparency, depth",
        id: "glassmorphism",
        name: "Glassmorphism",
        promptModifier: "glassmorphism design, frosted glass effects, semi-transparent surfaces, subtle depth and blur",
    },
    {
        description: "3D-like angles, technical, structured",
        id: "isometric",
        name: "Isometric",
        promptModifier: "isometric 3D design, angled perspective, technical illustration style, structured",
    },
    {
        description: "Soft washes, artistic, hand-painted feel",
        id: "watercolor",
        name: "Watercolor",
        promptModifier: "watercolor artistic design, soft paint washes, hand-painted feel, organic textures",
    },
    {
        description: "Two-color overlay, dramatic, modern",
        id: "duotone",
        name: "Duotone",
        promptModifier: "duotone design, two-color dramatic overlay, high contrast, modern graphic style",
    },
    {
        description: "Photo-based, realistic, editorial",
        id: "photographic",
        name: "Photographic",
        promptModifier: "photographic editorial design, realistic photography base, professional layout, magazine quality",
    },
];

/** Look up a style by ID. Returns undefined if not found. */
export const getDesignStyle = (id: string): DesignStyle | undefined => DESIGN_STYLES.find((s) => s.id === id);

/** All style IDs (for validation). */
export const DESIGN_STYLE_IDS = DESIGN_STYLES.map((s) => s.id);
