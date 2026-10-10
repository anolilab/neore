import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Create Presentation Tool
 * Creates a new slide presentation within the current thread.
 * Each slide is an HTML document rendered at 1920x1080.
 *
 * Lifecycle: presentation is created with status "generating", slides are
 * created one-by-one (each mutation is immediately visible to subscribers),
 * then status transitions to "complete" (or "error" on failure).
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

const AVAILABLE_STYLES = [
    "default",
    "velvet",
    "glacier",
    "ember",
    "sage",
    "obsidian",
    "coral",
    "platinum",
    "aurora",
    "midnight",
    "citrus",
    "silicon",
    "vercel",
    "legal",
    "investment",
    "luxury",
    "minimal",
    "medical",
    "startup",
    "academic",
    "vintage",
    "pencil",
    "frost",
    "sky",
    "clean",
    "forest",
    "electric",
    "bronze",
    "slate",
    "dune",
    "crimson",
    "canvas",
    "paper",
    "golden",
    "azure",
    "timber",
    "orchid",
    "ocean",
    "honey",
    "crystal",
] as const;

const STYLE_HINTS = `Style recommendations by content type:
- "academic" — research papers, lectures, thesis defenses
- "startup" — pitch decks, product launches, demos
- "investment" — financial reports, investor updates, earnings
- "medical" — healthcare, clinical data, patient education
- "legal" — legal briefs, compliance, regulatory
- "minimal" — clean general-purpose, when in doubt
- "vercel" — tech/developer-oriented content
- "luxury" — premium brands, high-end products
- "vintage" — historical content, retrospectives`;

const createPresentationTool = createTool<
    {
        description?: string;
        slides: {
            htmlContent: string;
            title: string;
        }[];
        styleName?: string;
        title: string;
    },
    {
        presentationId: string;
        slideCount: number;
        styleName: string;
        title: string;
    },
    ToolContext
>({
    description: `Create a new slide presentation in the current conversation. Use this when the user asks you to create a presentation, slideshow, pitch deck, or slide deck.

PLANNING — Before generating slides, mentally plan the presentation:
1. Identify the core message or narrative arc of the content
2. Plan an outline: title slide, key sections, transitions, and closing
3. For document-based presentations: extract the most important points, data, and quotes — do NOT simply transcribe text onto slides
4. Aim for 5–12 slides. Each slide should convey ONE key idea
5. Choose a visual approach: text-heavy informational vs visual/graphical vs mixed

SLIDE HTML — Each slide is rendered at 1920×1080 pixels. Write htmlContent as inner body HTML (no doctype/html/head/body tags). Use inline styles. The template applies the theme's fonts and colors automatically.

Guidelines for slide HTML:
- Use semantic HTML (h1, h2, p, ul, li, etc.)
- Use inline CSS for positioning and styling
- Use flexbox or grid for layouts
- Keep text concise — slides should be visual, not walls of text
- Use visual hierarchy: large titles, medium subtitles, compact body text
- For data: use styled HTML tables or simple chart-like layouts
- First slide should be a title slide with the presentation title and optional subtitle
- Last slide should be a summary, key takeaways, or call-to-action

DOCUMENT-BASED PRESENTATIONS — When creating slides from uploaded documents:
- Synthesize and restructure content, don't just copy paragraphs
- Highlight key findings, statistics, and conclusions
- Create visual representations of data when possible
- Include an agenda/overview slide after the title
- Add a "Key Takeaways" or "Summary" slide before the closing

${STYLE_HINTS}

Available style themes: ${AVAILABLE_STYLES.join(", ")}. Use "default" if unsure.`,
    execute: async (context, input) => {
        const { description, slides, styleName = "default", title } = input;

        if (!context.threadId) {
            throw new Error("Cannot create presentation: no active thread");
        }

        if (!context.userId) {
            throw new Error("Cannot create presentation: no authenticated user");
        }

        toolsLogger.debug(`[createPresentation] Creating "${title}" with ${slides.length} slides (style: ${styleName})`);

        // Check for a resumable presentation (previous failed/interrupted generation)
        let presentationId: Id<"presentations">;
        let startFromSlide = 0; // 0-based index into the slides array

        const resumable = await context.runQuery(internal.chat.slides.internal.getResumablePresentation, {
            threadId: context.threadId as Id<"threads">,
            title,
        });

        if (resumable) {
            // Resume: reuse existing presentation, skip already-created slides
            presentationId = resumable._id;
            startFromSlide = resumable.lastCompletedSlide ?? 0;

            toolsLogger.debug(`[createPresentation] Resuming presentation ${presentationId} from slide ${startFromSlide + 1}`);

            // Reset to generating status and update total
            await context.runMutation(internal.chat.slides.internal.updatePresentationStatus, {
                presentationId,
                status: "generating",
            });
        } else {
            // Create a new presentation record with "generating" status
            const result = await context.runMutation(internal.chat.slides.internal.createPresentation, {
                description,
                lastCompletedSlide: 0,
                name: title
                    .toLowerCase()
                    .replaceAll(/[^a-z0-9]+/g, "-")
                    .slice(0, 50),
                status: "generating",
                styleName,
                threadId: context.threadId as Id<"threads">,
                title,
                totalSlides: slides.length,
                userId: context.userId,
            });

            presentationId = result.presentationId;
        }

        // Create slides — first 2 new slides sequentially for fast UI feedback,
        // then remaining in parallel batches of 5 for speed
        try {
            const remainingSlides = slides.slice(startFromSlide);
            const SEQUENTIAL_COUNT = Math.min(2, remainingSlides.length);
            const BATCH_SIZE = 5;

            // Sequential: first new slides appear immediately for the subscriber
            for (let i = 0; i < SEQUENTIAL_COUNT; i += 1) {
                const slide = remainingSlides[i];

                if (!slide) {
                    break;
                }

                await context.runMutation(internal.chat.slides.internal.createSlide, {
                    htmlContent: slide.htmlContent,
                    presentationId,
                    slideNumber: startFromSlide + i + 1,
                    title: slide.title,
                });
            }

            // Parallel: remaining slides in batches
            for (let b = SEQUENTIAL_COUNT; b < remainingSlides.length; b += BATCH_SIZE) {
                const batch = remainingSlides.slice(b, Math.min(b + BATCH_SIZE, remainingSlides.length));

                await Promise.all(
                    batch.map((slide, index) =>
                        context.runMutation(internal.chat.slides.internal.createSlide, {
                            htmlContent: slide.htmlContent,
                            presentationId,
                            slideNumber: startFromSlide + b + index + 1,
                            title: slide.title,
                        }),
                    ),
                );
            }

            // Mark presentation as complete
            await context.runMutation(internal.chat.slides.internal.updatePresentationStatus, {
                presentationId,
                status: "complete",
            });
        } catch (error) {
            // Mark as error so the UI can show failure state; lastCompletedSlide is
            // already tracked per-slide, so a future call can resume from there
            await context.runMutation(internal.chat.slides.internal.updatePresentationStatus, {
                presentationId,
                status: "error",
            });
            throw error;
        }

        toolsLogger.debug(`[createPresentation] Created presentation ${presentationId} with ${slides.length} slides`);

        return {
            presentationId: presentationId as string,
            slideCount: slides.length,
            styleName,
            title,
        };
    },
    inputSchema: z
        .object({
            description: z.string().max(500).optional().meta({ description: "A short description of the presentation" }),
            slides: z
                .array(
                    z.object({
                        htmlContent: z
                            .string()
                            .min(1)
                            .meta({ description: "Slide body HTML content (inner body, no doctype/html/head/body wrappers). Use inline styles." }),
                        title: z.string().min(1).meta({ description: "Slide title" }),
                    }),
                )
                .min(1)
                .max(30)
                .meta({ description: "Array of slides in order" }),
            styleName: z.string().optional().meta({ description: "Theme style name (e.g. 'default', 'midnight', 'startup'). Defaults to 'default'." }),
            title: z.string().min(1).max(200).meta({ description: "The presentation title" }),
        })
        .strict(),
    title: "Create Presentation",
});

export default createPresentationTool;
