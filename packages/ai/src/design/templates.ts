/**
 * Pre-built design templates — Fabric.js JSON structures for common layouts.
 * Each template includes canvas dimensions, background, and positioned elements.
 */

/**
 * One entry of a Fabric.js `objects` array. The keys vary by `type` (Rect,
 * IText, …) and the value is only ever handed back to `canvas.loadFromJSON`,
 * so the properties stay primitive rather than being enumerated per shape.
 */
export type FabricObjectJson = Record<string, number | string | undefined>;

/**
 * The Fabric.js canvas serialisation a template ships.
 */
export interface FabricCanvasJson {
    background: string;
    objects: FabricObjectJson[];
    version: string;
}

export interface DesignTemplate {
    canvasJson: FabricCanvasJson;
    category: "social" | "marketing" | "presentation" | "minimal";
    description: string;
    height: number;
    id: string;
    name: string;
    presetId: string;
    width: number;
}

export const DESIGN_TEMPLATES: DesignTemplate[] = [
    // Social Media Templates
    {
        canvasJson: {
            background: "#1a1a2e",
            objects: [
                { fill: "transparent", height: 1000, left: 40, rx: 20, ry: 20, stroke: "#e94560", strokeWidth: 3, top: 40, type: "Rect", width: 1000 },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 96,
                    fontWeight: "bold",
                    left: 540,
                    originX: "center",
                    text: "BIG NEWS",
                    textAlign: "center",
                    top: 350,
                    type: "IText",
                },
                {
                    fill: "#e94560",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 36,
                    left: 540,
                    originX: "center",
                    text: "Your announcement here",
                    textAlign: "center",
                    top: 500,
                    type: "IText",
                },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 24,
                    left: 540,
                    opacity: 0.7,
                    originX: "center",
                    text: "Add more details below",
                    textAlign: "center",
                    top: 600,
                    type: "IText",
                },
            ],
            version: "6.6.1",
        },
        category: "social",
        description: "Bold announcement post with centered text",
        height: 1080,
        id: "social-announcement",
        name: "Social Announcement",
        presetId: "ig-post",
        width: 1080,
    },
    {
        canvasJson: {
            background: "#f5f0e8",
            objects: [
                { fill: "#c9a96e", fontFamily: "Georgia, serif", fontSize: 200, left: 100, opacity: 0.5, text: "\u{201C}", top: 180, type: "IText" },
                {
                    fill: "#2c2c2c",
                    fontFamily: "Georgia, serif",
                    fontSize: 48,
                    left: 540,
                    lineHeight: 1.4,
                    originX: "center",
                    text: "The only way to do\ngreat work is to love\nwhat you do.",
                    textAlign: "center",
                    top: 380,
                    type: "IText",
                },
                { stroke: "#c9a96e", strokeWidth: 2, type: "Line", x1: 440, x2: 640, y1: 680, y2: 680 },
                {
                    fill: "#666666",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 24,
                    left: 540,
                    originX: "center",
                    text: "— Steve Jobs",
                    textAlign: "center",
                    top: 720,
                    type: "IText",
                },
            ],
            version: "6.6.1",
        },
        category: "social",
        description: "Elegant quote card with attribution",
        height: 1080,
        id: "social-quote",
        name: "Quote Card",
        presetId: "ig-post",
        width: 1080,
    },
    {
        canvasJson: {
            background: "#0f0f23",
            objects: [
                { fill: "transparent", height: 1920, left: 0, stroke: "#6366f1", strokeWidth: 4, top: 0, type: "Rect", width: 1080 },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 80,
                    fontWeight: "bold",
                    left: 540,
                    lineHeight: 1.2,
                    originX: "center",
                    text: "SPECIAL\nOFFER",
                    textAlign: "center",
                    top: 300,
                    type: "IText",
                },
                { fill: "#6366f1", left: 390, opacity: 0.9, radius: 150, top: 600, type: "Circle" },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 64,
                    fontWeight: "bold",
                    left: 540,
                    lineHeight: 1.1,
                    originX: "center",
                    text: "50%\nOFF",
                    textAlign: "center",
                    top: 680,
                    type: "IText",
                },
                {
                    fill: "#a5b4fc",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 32,
                    left: 540,
                    originX: "center",
                    text: "Limited time only",
                    textAlign: "center",
                    top: 1050,
                    type: "IText",
                },
                { fill: "#6366f1", height: 70, left: 290, rx: 35, ry: 35, top: 1350, type: "Rect", width: 500 },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 28,
                    fontWeight: "bold",
                    left: 540,
                    originX: "center",
                    text: "SHOP NOW",
                    textAlign: "center",
                    top: 1365,
                    type: "IText",
                },
            ],
            version: "6.6.1",
        },
        category: "social",
        description: "Vertical story with promo layout",
        height: 1920,
        id: "social-story-promo",
        name: "Story Promo",
        presetId: "ig-story",
        width: 1080,
    },

    // Marketing Templates
    {
        canvasJson: {
            background: "#0a192f",
            objects: [
                { fill: "#112240", left: -100, opacity: 0.5, radius: 400, top: -200, type: "Circle" },
                { fill: "#112240", left: 1500, opacity: 0.5, radius: 300, top: 100, type: "Circle" },
                {
                    fill: "#ccd6f6",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 64,
                    fontWeight: "bold",
                    left: 100,
                    text: "Welcome to the Future",
                    top: 120,
                    type: "IText",
                },
                {
                    fill: "#8892b0",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 28,
                    left: 100,
                    text: "Discover what's possible with our platform",
                    top: 220,
                    type: "IText",
                },
                { fill: "#64ffda", height: 56, left: 100, rx: 8, ry: 8, top: 320, type: "Rect", width: 200 },
                { fill: "#0a192f", fontFamily: "Inter, sans-serif", fontSize: 20, fontWeight: "600", left: 140, text: "Get Started", top: 333, type: "IText" },
            ],
            version: "6.6.1",
        },
        category: "marketing",
        description: "Full-width promotional banner",
        height: 480,
        id: "marketing-banner",
        name: "Web Banner",
        presetId: "web-banner",
        width: 1920,
    },
    {
        canvasJson: {
            background: "#ffffff",
            objects: [
                { fill: "#f8f9fa", height: 400, left: 0, top: 0, type: "Rect", width: 600 },
                { fill: "#4A90D9", height: 8, left: 0, top: 0, type: "Rect", width: 600 },
                {
                    fill: "#1a1a1a",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 36,
                    fontWeight: "bold",
                    left: 300,
                    originX: "center",
                    text: "Newsletter Title",
                    textAlign: "center",
                    top: 100,
                    type: "IText",
                },
                {
                    fill: "#666666",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 20,
                    left: 300,
                    originX: "center",
                    text: "Your weekly update is here",
                    textAlign: "center",
                    top: 170,
                    type: "IText",
                },
                { fill: "#4A90D9", height: 48, left: 200, rx: 24, ry: 24, top: 260, type: "Rect", width: 200 },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 18,
                    fontWeight: "600",
                    left: 300,
                    originX: "center",
                    text: "Read More",
                    textAlign: "center",
                    top: 270,
                    type: "IText",
                },
            ],
            version: "6.6.1",
        },
        category: "marketing",
        description: "Newsletter hero image",
        height: 400,
        id: "marketing-email-hero",
        name: "Email Hero",
        presetId: "email-hero",
        width: 600,
    },

    // Presentation Templates
    {
        canvasJson: {
            background: "#ffffff",
            objects: [
                { fill: "#2563eb", height: 1080, left: 0, top: 0, type: "Rect", width: 80 },
                {
                    fill: "#1e293b",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 72,
                    fontWeight: "bold",
                    left: 160,
                    text: "Presentation Title",
                    top: 300,
                    type: "IText",
                },
                { fill: "#64748b", fontFamily: "Inter, sans-serif", fontSize: 32, left: 160, text: "Subtitle goes here", top: 410, type: "IText" },
                { stroke: "#2563eb", strokeWidth: 3, type: "Line", x1: 160, x2: 500, y1: 520, y2: 520 },
                { fill: "#94a3b8", fontFamily: "Inter, sans-serif", fontSize: 20, left: 160, text: "Author Name  |  Date", top: 560, type: "IText" },
            ],
            version: "6.6.1",
        },
        category: "presentation",
        description: "Clean title slide for presentations",
        height: 1080,
        id: "presentation-title",
        name: "Title Slide",
        presetId: "custom-landscape",
        width: 1920,
    },
    {
        canvasJson: {
            background: "#f8fafc",
            objects: [
                { fill: "#2563eb", height: 6, left: 0, top: 0, type: "Rect", width: 1920 },
                {
                    fill: "#1e293b",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 48,
                    fontWeight: "bold",
                    left: 120,
                    text: "Section Title",
                    top: 80,
                    type: "IText",
                },
                { stroke: "#2563eb", strokeWidth: 2, type: "Line", x1: 120, x2: 460, y1: 160, y2: 160 },
                {
                    fill: "#334155",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 28,
                    left: 120,
                    lineHeight: 1.8,
                    text: "•  First key point\n•  Second key point\n•  Third key point\n•  Fourth key point",
                    top: 220,
                    type: "IText",
                },
            ],
            version: "6.6.1",
        },
        category: "presentation",
        description: "Content slide with heading and bullets",
        height: 1080,
        id: "presentation-content",
        name: "Content Slide",
        presetId: "custom-landscape",
        width: 1920,
    },

    // Minimal Templates
    {
        canvasJson: {
            background: "#fafafa",
            objects: [
                { fill: "#ffffff", height: 530, left: 50, rx: 16, ry: 16, stroke: "#e5e5e5", strokeWidth: 1, top: 50, type: "Rect", width: 1100 },
                { fill: "#3b82f6", left: 530, radius: 40, top: 140, type: "Circle" },
                {
                    fill: "#171717",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 40,
                    fontWeight: "bold",
                    left: 600,
                    originX: "center",
                    text: "Your Title Here",
                    textAlign: "center",
                    top: 250,
                    type: "IText",
                },
                {
                    fill: "#737373",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 20,
                    left: 600,
                    originX: "center",
                    text: "A brief description of your content",
                    textAlign: "center",
                    top: 320,
                    type: "IText",
                },
                {
                    fill: "#a3a3a3",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 16,
                    left: 600,
                    originX: "center",
                    text: "yoursite.com",
                    textAlign: "center",
                    top: 420,
                    type: "IText",
                },
            ],
            version: "6.6.1",
        },
        category: "minimal",
        description: "Simple card with centered content",
        height: 630,
        id: "minimal-card",
        name: "Minimal Card",
        presetId: "og-image",
        width: 1200,
    },
    {
        canvasJson: {
            background: "#667eea",
            objects: [
                { fill: "#764ba2", height: 630, left: 0, opacity: 0.7, top: 0, type: "Rect", width: 1200 },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 56,
                    fontWeight: "bold",
                    left: 600,
                    originX: "center",
                    text: "Beautiful Design",
                    textAlign: "center",
                    top: 220,
                    type: "IText",
                },
                {
                    fill: "#ffffff",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 24,
                    left: 600,
                    opacity: 0.85,
                    originX: "center",
                    text: "Create something amazing",
                    textAlign: "center",
                    top: 310,
                    type: "IText",
                },
                { fill: "#ffffff", height: 56, left: 475, rx: 28, ry: 28, top: 400, type: "Rect", width: 250 },
                {
                    fill: "#667eea",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 20,
                    fontWeight: "600",
                    left: 600,
                    originX: "center",
                    text: "Learn More",
                    textAlign: "center",
                    top: 412,
                    type: "IText",
                },
            ],
            version: "6.6.1",
        },
        category: "minimal",
        description: "Modern gradient background card",
        height: 630,
        id: "minimal-gradient",
        name: "Gradient Card",
        presetId: "og-image",
        width: 1200,
    },
];

/** Look up a template by ID. */
export const getDesignTemplate = (id: string): DesignTemplate | undefined => DESIGN_TEMPLATES.find((t) => t.id === id);

/** Get all templates in a given category. */
export const getTemplatesByCategory = (category: DesignTemplate["category"]): DesignTemplate[] => DESIGN_TEMPLATES.filter((t) => t.category === category);
