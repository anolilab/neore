// ---------------------------------------------------------------------------
// Shared model data for marketing pages and footer SEO links
// ---------------------------------------------------------------------------

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ModelCatalogEntry } from "@neore/ai/models";
import { IMAGE_CATALOG, TEXT_CATALOG, VIDEO_CATALOG } from "@neore/ai/models";

export type { ModelCatalogEntry };

export type MarketingModel = ModelCatalogEntry & {
    /** One sentence targeting search intent — what this model is ideal for */
    bestFor: MessageDescriptor;
    /** Exactly 3 key strengths, rendered as bullets on the detail page */
    strengths: [MessageDescriptor, MessageDescriptor, MessageDescriptor];
    /** Use-case / capability tags shown as chips */
    tags: MessageDescriptor[];
};

/** Convert a display name to a URL-safe slug */
export const toSlug = (name: string): string =>
    name
        .toLowerCase()
        .replaceAll(/[\s.]+/g, "-")
        .replaceAll(/[^a-z0-9-]/g, "");

type SeoExtras = { bestFor: MessageDescriptor; strengths: [MessageDescriptor, MessageDescriptor, MessageDescriptor]; tags: MessageDescriptor[] };

const SEO_EXTRAS: Record<string, SeoExtras> = {
    "chatgpt-image": {
        bestFor: msg`Professionals who need versatile, high-quality image creation from descriptive text prompts`,
        strengths: [msg`Broad style range from photorealism to illustration`, msg`Strong prompt adherence`, msg`Reliable quality across diverse subjects`],
        tags: [msg`photorealism`, msg`illustration`, msg`versatile`],
    },
    "chatgpt-1-5": {
        bestFor: msg`Designers creating logos, icons, and brand assets where text and layout precision matter most`,
        strengths: [msg`Exceptional text rendering inside images`, msg`Superior logo and icon design`, msg`High reasoning for complex compositions`],
        tags: [msg`logos`, msg`vector art`, msg`brand design`, msg`typography`],
    },
    flux: {
        bestFor: msg`Creators who use custom LoRA style models or need fast iteration at minimal cost`,
        strengths: [msg`Native LoRA support for custom styles`, msg`Fast generation speed`, msg`Open source foundation with broad community support`],
        tags: [msg`LoRA`, msg`custom styles`, msg`portraits`, msg`fast`],
    },
    "flux-1-1-pro": {
        bestFor: msg`Professional creators who need advanced photorealism with efficient generation times`,
        strengths: [
            msg`Advanced photorealism from Black Forest Labs`,
            msg`Efficient generation without quality sacrifice`,
            msg`Strong adherence to complex prompts`,
        ],
        tags: [msg`photorealism`, msg`professional`, msg`portraits`],
    },
    "flux-1-1-pro-ultra": {
        bestFor: msg`Commercial projects demanding the absolute best image quality from Black Forest Labs`,
        strengths: [msg`Highest quality output from Black Forest Labs`, msg`Ultra-high resolution detail`, msg`Premium sharpness for commercial use`],
        tags: [msg`photorealism`, msg`high resolution`, msg`commercial`],
    },
    "flux-2": {
        bestFor: msg`Creators who want to both generate and edit images with a single frontier-quality model`,
        strengths: [msg`Enhanced photorealism over Flux 1.x`, msg`Native image editing built into the model`, msg`FLUX.2 architecture improvements`],
        tags: [msg`image editing`, msg`photorealism`, msg`versatile`],
    },
    "flux-2-flex": {
        bestFor: msg`Projects requiring clean, readable text and typography rendered within generated images`,
        strengths: [msg`Good text rendering inside images`, msg`Reliable typography quality`, msg`Medium quality at manageable cost`],
        tags: [msg`text rendering`, msg`typography`, msg`medium quality`],
    },
    "flux-2-klein": {
        bestFor: msg`High-volume generation workflows where generation speed and cost matter more than peak quality`,
        strengths: [msg`Very fast generation speed`, msg`Next-gen Flux architecture at budget cost`, msg`Efficient for batch workflows`],
        tags: [msg`budget`, msg`fast`, msg`batch generation`],
    },
    "flux-2-max": {
        bestFor: msg`Projects requiring the maximum possible image quality from Black Forest Labs`,
        strengths: [msg`Frontier-tier quality from BFL`, msg`Maximum detail and sharpness`, msg`Best-in-class photorealism`],
        tags: [msg`frontier`, msg`photorealism`, msg`commercial`],
    },
    "flux-2-pro": {
        bestFor: msg`General creative work requiring a good balance of image quality, speed, and cost`,
        strengths: [msg`Balanced quality-to-cost ratio`, msg`Versatile across use cases`, msg`Reliable Flux output quality`],
        tags: [msg`photorealism`, msg`versatile`, msg`balanced`],
    },
    "flux-kontext": {
        bestFor: msg`Editing and remixing existing images with natural-language prompt instructions, optimized for Krea workflows`,
        strengths: [msg`Optimized for image editing with prompts`, msg`Context-aware edits that preserve the original`, msg`Krea workflow integration`],
        tags: [msg`image editing`, msg`reference images`, msg`Krea optimized`],
    },
    "flux-kontext-pro": {
        bestFor: msg`Professional image editors who need precise, prompt-driven photo editing with frontier-quality results`,
        strengths: [msg`Best-in-class prompt-based image editing`, msg`Strong reference image support`, msg`Professional-grade editing precision`],
        tags: [msg`image editing`, msg`reference images`, msg`professional`],
    },
    "flux-1-krea": {
        bestFor: msg`Artists who want Krea's aesthetic quality in an open-source, accessible model`,
        strengths: [msg`Distilled from Krea 1 for open access`, msg`Krea's signature aesthetic quality`, msg`Open source flexibility`],
        tags: [msg`creative`, msg`open source`, msg`artistic`],
    },
    "ideogram-3-0": {
        bestFor: msg`Marketers and designers who need beautiful, aesthetic images with strong typography and text rendering`,
        strengths: [msg`Highly aesthetic visual output`, msg`Industry-leading text rendering inside images`, msg`Versatile general-purpose capability`],
        tags: [msg`aesthetics`, msg`typography`, msg`general purpose`, msg`marketing`],
    },
    "imagen-3": {
        bestFor: msg`High-quality image generation using Google's proven AI capabilities for photorealistic results`,
        strengths: [msg`Google's proven photorealism quality`, msg`Strong subject and scene understanding`, msg`Reliable and consistent outputs`],
        tags: [msg`photorealism`, msg`Google AI`, msg`reliable`],
    },
    "imagen-4": {
        bestFor: msg`Current-generation photorealistic image generation with improved detail and better prompt following`,
        strengths: [msg`Google's current-generation quality`, msg`Improved detail over Imagen 3`, msg`Better prompt adherence`],
        tags: [msg`photorealism`, msg`Google AI`, msg`current gen`],
    },
    "imagen-4-fast": {
        bestFor: msg`Rapid prototyping and iteration using Google's AI at maximum generation speed`,
        strengths: [msg`Google's fastest image generation`, msg`Good quality at speed`, msg`Cost-effective for high-volume use`],
        tags: [msg`fast`, msg`Google AI`, msg`prototyping`],
    },
    "imagen-4-ultra": {
        bestFor: msg`Premium projects requiring Google's absolute best image quality and ultra-fine detail`,
        strengths: [msg`Google's highest-quality image model`, msg`Ultra-fine detail and realism`, msg`Best prompt understanding in the Imagen family`],
        tags: [msg`photorealism`, msg`ultra quality`, msg`Google flagship`],
    },
    "kling-o1-image": {
        bestFor: msg`Complex compositions that require handling multiple reference images and high-intelligence scene generation`,
        strengths: [
            msg`Advanced handling of multiple reference images`,
            msg`Frontier intelligence for complex scenes`,
            msg`Strong scene and style consistency`,
        ],
        tags: [msg`reference images`, msg`complex scenes`, msg`frontier`, msg`composition`],
    },
    "nano-banana": {
        bestFor: msg`Creators who need a highly versatile model that handles diverse creative tasks across styles and subjects`,
        strengths: [
            msg`Multi-turn conversational image editing`,
            msg`Strong character consistency across edits`,
            msg`Versatile across photorealism and illustration`,
        ],
        tags: [msg`versatile`, msg`general purpose`, msg`creative`, msg`Google AI`],
    },
    "nano-banana-pro": {
        bestFor: msg`Professional creators who need maximum intelligence for visually complex or conceptually demanding images`,
        strengths: [msg`Google's most advanced image generation model`, msg`Premium visual quality`, msg`Superior understanding of complex visual concepts`],
        tags: [msg`frontier intelligence`, msg`professional`, msg`complex prompts`],
    },
    "nano-banana-2": {
        bestFor: msg`Creators who need fast, frontier-quality image generation and editing with strong character consistency`,
        strengths: [
            msg`Google's new state-of-the-art fast model`,
            msg`Frontier quality at a faster latency than Pro`,
            msg`Strong multi-turn editing and reference workflows`,
        ],
        tags: [msg`frontier`, msg`fast`, msg`editing`, msg`Google AI`],
    },
    qwen: {
        bestFor: msg`Versatile image generation with strong prompt-following from Alibaba's AI platform`,
        strengths: [msg`Good prompt adherence across subjects`, msg`Semi-realistic visual style`, msg`Solid general-purpose capability`],
        tags: [msg`semi-realistic`, msg`prompt adherence`, msg`versatile`],
    },
    "qwen-image-2512": {
        bestFor: msg`Creators who want open-source image generation competitive with closed models at an accessible price via Alibaba Cloud`,
        strengths: [msg`Open-source with competitive closed-model quality`, msg`Strong prompt adherence`, msg`Accessible pricing via Alibaba Cloud`],
        tags: [msg`open source`, msg`affordable`, msg`high quality`],
    },
    "recraft-v3": {
        bestFor: msg`Brand and design teams who need long-text rendering, vector art, and brand-style image generation`,
        strengths: [msg`Long text generation in images`, msg`Vector art output and brand-style support`, msg`Strong typography for logos and marketing`],
        tags: [msg`typography`, msg`vector`, msg`brand style`],
    },
    "recraft-v4": {
        bestFor: msg`Graphic designers who need exceptionally sharp, detailed images with perfect text rendering in both Standard and Pro modes`,
        strengths: [msg`Exceptionally sharp detail and clarity`, msg`Industry-best typography and text in images`, msg`Flexible Standard and Pro output modes`],
        tags: [msg`typography`, msg`sharp detail`, msg`commercial design`, msg`graphic design`],
    },
    "runway-gen-4-image": {
        bestFor: msg`Filmmakers and videographers creating cinematic stills with reference image guidance`,
        strengths: [msg`Cinematic visual quality`, msg`Reference image support for style consistency`, msg`Film-grade aesthetic output`],
        tags: [msg`cinematic`, msg`reference images`, msg`film quality`],
    },
    "seedream-4": {
        bestFor: msg`Commercial creators who need high-quality photorealistic images with clean, readable text overlays`,
        strengths: [msg`High quality photorealism from ByteDance`, msg`Excellent text rendering in images`, msg`Strong commercial-grade output`],
        tags: [msg`photorealism`, msg`text rendering`, msg`commercial`],
    },
    "seedream-4-5": {
        bestFor: msg`Everyday photorealistic image generation at an accessible quality and cost level`,
        strengths: [msg`Good photorealism at medium quality tier`, msg`Balanced quality-to-cost ratio`, msg`ByteDance's accessible image model`],
        tags: [msg`photorealism`, msg`medium quality`, msg`accessible`],
    },
    "seedream-5-lite": {
        bestFor: msg`Images that require current knowledge, web search context, or complex reasoning about the subject matter`,
        strengths: [msg`Built-in reasoning before generating`, msg`Web search integration for current topics`, msg`Knowledge-aware image generation`],
        tags: [msg`reasoning`, msg`web search`, msg`knowledge-aware`],
    },
    "wan-2-2-image": {
        bestFor: msg`Artistic and cinematic projects where exceptional texture quality and depth take priority over speed`,
        strengths: [msg`Cinematic texture and material quality`, msg`Realistic depth and lighting`, msg`Artistic quality for detailed compositions`],
        tags: [msg`cinematic`, msg`textures`, msg`artistic`, msg`realistic`],
    },
    "z-image": {
        bestFor: msg`High-volume, time-sensitive workflows where generation speed is the top priority`,
        strengths: [msg`Fastest image generation available`, msg`Consistent and realistic output`, msg`Optimized for speed at scale`],
        tags: [msg`fast`, msg`realistic`, msg`high volume`],
    },
    "01-live": {
        bestFor: msg`Creators who need to animate realistic human subjects with natural, lifelike movement`,
        strengths: [msg`Specialized for animating human subjects`, msg`Natural and lifelike movement`, msg`High-quality output for people-focused videos`],
        tags: [msg`people`, msg`animation`, msg`realistic motion`],
    },
    "grok-imagine": {
        bestFor: msg`Fast, high-quality video generation backed by xAI's foundation model technology`,
        strengths: [msg`Fast generation with high output quality`, msg`xAI's foundation model capabilities`, msg`Reliable results across diverse prompts`],
        tags: [msg`fast`, msg`high quality`, msg`xAI`],
    },
    hailuo: {
        bestFor: msg`Cinematic video creation where precise, controlled camera movements are essential to the storytelling`,
        strengths: [msg`Advanced camera movement control`, msg`Cinematic visual quality`, msg`Stable, consistent frame output`],
        tags: [msg`camera control`, msg`cinematic`, msg`high quality`],
    },
    "hailuo-02": {
        bestFor: msg`Balanced video generation from MiniMax Hailuo 02 at standard tier`,
        strengths: [msg`MiniMax Hailuo 02 standard tier`, msg`Strong motion quality`, msg`Reliable everyday output`],
        tags: [msg`dynamic motion`, msg`balanced`, msg`everyday`],
    },
    "hailuo-02-pro": {
        bestFor: msg`High-quality video creation requiring expressive, dynamic motion from MiniMax's frontier tier`,
        strengths: [msg`MiniMax Hailuo 02 pro tier`, msg`Expressive dynamic motion`, msg`Cinematic depth and visual flair`],
        tags: [msg`dynamic motion`, msg`frontier`, msg`cinematic`],
    },
    "hailuo-2-3": {
        bestFor: msg`Professional video creation demanding the latest and most capable model from Hailuo`,
        strengths: [msg`Latest frontier generation from Hailuo`, msg`Excellent dynamic motion quality`, msg`Cutting-edge video output`],
        tags: [msg`dynamic motion`, msg`frontier`, msg`latest`],
    },
    "hailuo-2-3-fast": {
        bestFor: msg`Cost-effective video generation that covers most standard use cases at the lowest price point`,
        strengths: [msg`Cheapest medium-quality video model`, msg`Fast generation speed`, msg`Covers the majority of everyday video use cases`],
        tags: [msg`budget`, msg`fast`, msg`everyday use`],
    },
    hunyuan: {
        bestFor: msg`Iterative video creation where live previews help refine results before committing to final generation`,
        strengths: [msg`Real-time live preview during generation`, msg`Very affordable pricing`, msg`Fast iteration cycle for creative exploration`],
        tags: [msg`live preview`, msg`fast`, msg`affordable`],
    },
    "kling-1-0-pro": {
        bestFor: msg`Projects that need longer 10-second video clips with a high degree of creative control`,
        strengths: [msg`Supports 10-second video durations`, msg`High level of creative control`, msg`Consistent, reliable output quality`],
        tags: [msg`long duration`, msg`controlled`, msg`10 seconds`],
    },
    "kling-1-6": {
        bestFor: msg`Reliable video generation for complex scenes using Kling's proven previous-generation technology`,
        strengths: [msg`Strong complex scene handling`, msg`Proven reliability from previous generation`, msg`Good balance of quality and accessibility`],
        tags: [msg`complex scenes`, msg`reliable`, msg`versatile`],
    },
    "kling-2-0": {
        bestFor: msg`Aesthetically driven video projects requiring high-quality, versatile output across diverse creative subjects`,
        strengths: [msg`Great aesthetic quality and visual polish`, msg`Versatile across diverse video subjects`, msg`Balanced performance for creative work`],
        tags: [msg`aesthetics`, msg`high quality`, msg`versatile`],
    },
    "kling-2-1": {
        bestFor: msg`Projects that require full 1080p video resolution from a frontier model`,
        strengths: [msg`Full 1080p high-definition video output`, msg`Frontier-level quality`, msg`Crisp detail and clarity`],
        tags: [msg`1080p`, msg`frontier`, msg`high resolution`],
    },
    "kling-2-5": {
        bestFor: msg`Video creators who need expressive motion with flexible visual style adaptation and next-gen quality`,
        strengths: [msg`Improved motion dynamics over Kling 2.x`, msg`Enhanced visual style adaptation`, msg`Next-generation architecture`],
        tags: [msg`dynamic motion`, msg`style adaptation`, msg`next gen`],
    },
    "kling-2-5-turbo": {
        bestFor: msg`Fast frontier video generation with unmatched motion fluidity where speed and quality both matter`,
        strengths: [msg`Unparalleled motion fluidity`, msg`Top-tier text-to-video quality`, msg`Turbo-speed generation without quality loss`],
        tags: [msg`motion fluidity`, msg`text-to-video`, msg`fast frontier`],
    },
    "kling-2-6": {
        bestFor: msg`Videos that need synchronized native audio generation without requiring a separate audio production step`,
        strengths: [msg`Native audio generation built-in`, msg`Latest frontier video quality from Kling`, msg`Synchronized audio and visual output`],
        tags: [msg`native audio`, msg`frontier`, msg`audio-video`],
    },
    "kling-3-0": {
        bestFor: msg`Long-form video production requiring native audio, extended durations, and maximum quality from Kling`,
        strengths: [msg`Native audio generation with extended durations`, msg`Latest and most capable from Kling`, msg`Frontier quality for long-form video`],
        tags: [msg`native audio`, msg`extended duration`, msg`latest frontier`],
    },
    "kling-o1": {
        bestFor: msg`Complex video concepts that benefit from deep AI reasoning before the generation process begins`,
        strengths: [
            msg`Reasons through the prompt before generating`,
            msg`Intelligent scene composition`,
            msg`Better handling of complex multi-element prompts`,
        ],
        tags: [msg`reasoning`, msg`intelligent`, msg`complex prompts`],
    },
    "kling-o3": {
        bestFor: msg`Videos requiring AI reasoning with higher quality output than Kling o1 for demanding creative briefs`,
        strengths: [msg`Advanced reasoning with improved output quality`, msg`Smarter composition over o1`, msg`Handles demanding creative concepts`],
        tags: [msg`reasoning`, msg`advanced`, msg`creative direction`],
    },
    "ltx-video": {
        bestFor: msg`Fast, affordable video generation from an open-source model`,
        strengths: [msg`Low latency text-to-video`, msg`Open-source from Lightricks`, msg`Budget-friendly`],
        tags: [msg`fast`, msg`open source`, msg`budget`],
    },
    "ltx-2": {
        bestFor: msg`Creators who want production-grade audio and video from a single open-source model — lip sync, foley, and ambient sound included`,
        strengths: [
            msg`Native synchronized audio generation in a single model pass`,
            msg`Open-source under permissive license (Apache 2.0)`,
            msg`Production-grade 4K at up to 50 FPS with lip sync and foley`,
        ],
        tags: [msg`native audio`, msg`open source`, msg`audio-video`, msg`4K`],
    },
    "ray-2": {
        bestFor: msg`Natural, fluid motion video generation from a trusted provider at an accessible quality level`,
        strengths: [msg`Natural and fluid motion quality`, msg`Luma Labs AI foundation`, msg`Reliable output for general video`],
        tags: [msg`natural motion`, msg`Luma`, msg`fluid motion`],
    },
    "ray-3": {
        bestFor: msg`Creators who need cinematic-quality video with noticeably improved motion fidelity from Luma Labs`,
        strengths: [
            msg`Cinematic-quality output with improved motion over Ray 2`,
            msg`Strong temporal consistency across frames`,
            msg`Luma's best-in-class video model`,
        ],
        tags: [msg`cinematic`, msg`natural motion`, msg`Luma`, msg`high quality`],
    },
    "runway-gen-3": {
        bestFor: msg`Cinematic video projects that value visual consistency and proven reliability over cutting-edge features`,
        strengths: [msg`High visual consistency frame-to-frame`, msg`Proven cinematic aesthetic`, msg`Reliable and predictable outputs`],
        tags: [msg`cinematic`, msg`consistency`, msg`reliable`],
    },
    "runway-gen-4": {
        bestFor: msg`Filmmakers creating cinematic videos with a strong focus on visual narrative and storytelling quality`,
        strengths: [msg`Strong cinematic visual focus`, msg`Good quality for storytelling`, msg`Runway's signature film aesthetic`],
        tags: [msg`cinematic`, msg`storytelling`, msg`film quality`],
    },
    "runway-gen-4-5": {
        bestFor: msg`Professional video creators who need Runway's latest and most capable frontier-quality model`,
        strengths: [msg`Latest generation from Runway`, msg`Native text-to-video at frontier quality`, msg`Professional-grade cinematic output`],
        tags: [msg`frontier`, msg`text-to-video`, msg`Runway flagship`],
    },
    "seedance-1-5-pro": {
        bestFor: msg`Creators who need audio-inclusive video generation with precise control over start and end frames`,
        strengths: [msg`Native audio generation included`, msg`End frame support for precise control`, msg`ByteDance medium-pro quality tier`],
        tags: [msg`native audio`, msg`end frame`, msg`precise control`],
    },
    "seedance-1-5-lite": {
        bestFor: msg`Quick, affordable everyday video generation from ByteDance's Seedance 1.5 family`,
        strengths: [msg`Fast generation speed`, msg`Very affordable pricing`, msg`ByteDance Seedance foundation`],
        tags: [msg`fast`, msg`affordable`, msg`everyday use`],
    },
    "seedance-2-0": {
        bestFor: msg`Frontier-quality video creation requiring end-frame control, reference inputs, and the latest ByteDance generation`,
        strengths: [
            msg`Next-generation Seedance 2.0 architecture from ByteDance`,
            msg`End-frame and reference-image conditioning support`,
            msg`Frontier quality with strong motion and temporal consistency`,
        ],
        tags: [msg`frontier`, msg`reference video`, msg`ByteDance`, msg`end frame`],
    },
    "seedance-2-0-fast": {
        bestFor: msg`Fast Seedance 2.0 iterations when speed matters more than maximum quality`,
        strengths: [
            msg`Faster, cheaper variant of Seedance 2.0`,
            msg`Quick iteration cycles at high quality`,
            msg`Same frontier architecture, optimized for speed`,
        ],
        tags: [msg`fast`, msg`ByteDance`, msg`iteration`],
    },
    "pika-v2-2": {
        bestFor: msg`Narrative video creators who want Pika Labs' storytelling-focused model with strong character and scene control`,
        strengths: [
            msg`Pika Labs 2.2 — narrative-focused generation`,
            msg`Strong character and scene consistency`,
            msg`Versatile aspect ratios for social and cinematic formats`,
        ],
        tags: [msg`narrative`, msg`Pika Labs`, msg`storytelling`],
    },
    "seedance-pro": {
        bestFor: msg`Fast, high-quality video generation from ByteDance's professional-tier Seedance model`,
        strengths: [
            msg`Fast generation with professional-quality output`,
            msg`ByteDance's high-quality Seedance tier`,
            msg`Reliable results for demanding creative work`,
        ],
        tags: [msg`fast`, msg`high quality`, msg`professional`],
    },
    "seedance-pro-fast": {
        bestFor: msg`Long video clips (up to 12 seconds) generated quickly at an affordable price point`,
        strengths: [msg`Up to 12-second video duration support`, msg`Fast generation speed`, msg`Cost-effective for long clips`],
        tags: [msg`long duration`, msg`12 seconds`, msg`fast`, msg`affordable`],
    },
    "sora-2": {
        bestFor: msg`Videos that benefit from deep world knowledge and realistic physics simulation from OpenAI`,
        strengths: [msg`Rich world knowledge baked into generation`, msg`Stable physical structures and motion`, msg`OpenAI-quality video coherence`],
        tags: [msg`world knowledge`, msg`stable physics`, msg`OpenAI`],
    },
    "sora-2-pro": {
        bestFor: msg`Premium video projects requiring OpenAI's absolute best and most advanced video generation capability`,
        strengths: [msg`OpenAI's most advanced video model`, msg`Premium generation quality`, msg`Flagship-tier capabilities across all dimensions`],
        tags: [msg`OpenAI flagship`, msg`frontier`, msg`premium video`],
    },
    "veo-2": {
        bestFor: msg`High-quality video generation using Google's established Veo technology for cinematic results`,
        strengths: [msg`High quality from Google's Veo series`, msg`Cinematic visual output`, msg`Strong subject understanding`],
        tags: [msg`Google AI`, msg`high quality`, msg`cinematic`],
    },
    "veo-3": {
        bestFor: msg`High-quality video with audio using Google's frontier Veo model for demanding creative projects`,
        strengths: [msg`Frontier video quality with native audio`, msg`High-fidelity visuals from Google`, msg`Foundation of Google's leading Veo 3.x series`],
        tags: [msg`native audio`, msg`Google AI`, msg`frontier`],
    },
    "veo-3-fast": {
        bestFor: msg`Budget-conscious access to Veo 3's audio capabilities at faster speeds and lower cost`,
        strengths: [msg`Faster and more affordable than Veo 3`, msg`Includes audio generation`, msg`Good Veo quality at reduced cost`],
        tags: [msg`native audio`, msg`fast`, msg`affordable Google AI`],
    },
    "veo-3-1": {
        bestFor: msg`Professional productions that demand the absolute best AI video available — with audio and reference image support`,
        strengths: [
            msg`The highest-quality AI video model available`,
            msg`Native audio generation included`,
            msg`Reference image support for style consistency`,
        ],
        tags: [msg`best video model`, msg`native audio`, msg`reference images`, msg`Google flagship`],
    },
    "veo-3-1-fast": {
        bestFor: msg`Accessing Veo 3.1 quality with audio at faster speeds and a more accessible price point`,
        strengths: [msg`Faster version of the top-ranked Veo 3.1`, msg`Audio generation included`, msg`Better cost efficiency than the full model`],
        tags: [msg`native audio`, msg`fast`, msg`affordable frontier`],
    },
    "vidu-q2": {
        bestFor: msg`Style-consistent video generation guided by reference images to maintain visual coherence`,
        strengths: [msg`Strong reference image support`, msg`High-quality video output`, msg`Consistent style and character fidelity`],
        tags: [msg`reference images`, msg`style consistency`, msg`high quality`],
    },
    "vidu-q3": {
        bestFor: msg`Anime and stylized animation projects requiring consistent character design and expressive motion`,
        strengths: [msg`Excellent anime and stylized animation quality`, msg`Consistent character design across frames`, msg`Expressive stylized motion`],
        tags: [msg`anime`, msg`stylized animation`, msg`character consistency`],
    },
    "wan-2-1": {
        bestFor: msg`Custom-style video generation with LoRA support at the lowest possible cost and fastest speed`,
        strengths: [msg`Video LoRA support for custom styles`, msg`Fastest in the Wan model family`, msg`Very low cost per generation`],
        tags: [msg`LoRA`, msg`custom styles`, msg`fast`, msg`budget`],
    },
    "wan-2-2": {
        bestFor: msg`Quick, affordable video generation using Alibaba's Wan model at a fast, lower-quality tier`,
        strengths: [msg`Fast generation speed`, msg`Lower cost than Wan 2.5`, msg`Alibaba's accessible video foundation`],
        tags: [msg`fast`, msg`affordable`, msg`Alibaba`],
    },
    "wan-2-5": {
        bestFor: msg`Medium-quality video generation with Alibaba's latest Wan improvements for general-purpose use`,
        strengths: [msg`Latest medium-quality from Alibaba`, msg`Improved quality over Wan 2.2`, msg`Good balance of cost and capability`],
        tags: [msg`medium quality`, msg`latest`, msg`general purpose`],
    },
    "wan-2-6": {
        bestFor: msg`General-purpose video generation using Alibaba's latest-generation Wan model`,
        strengths: [msg`Latest generation from Alibaba`, msg`Continued quality improvements over 2.5`, msg`Reliable for diverse video subjects`],
        tags: [msg`latest generation`, msg`Alibaba`, msg`general purpose`],
    },
    "claude-haiku-4-5": {
        bestFor: msg`High-throughput tasks requiring fast responses at the lowest Claude cost`,
        strengths: [
            msg`Fastest Claude response times for high-volume tasks`,
            msg`Most affordable model in the Claude 4.x family`,
            msg`Reliable Anthropic quality for simple tasks and automation`,
        ],
        tags: [msg`fast`, msg`affordable`, msg`lightweight`],
    },
    "claude-sonnet-4": {
        bestFor: msg`Teams needing a balanced, capable Claude model for everyday production workloads`,
        strengths: [
            msg`Best balance of speed and intelligence in the Claude 4 family`,
            msg`Strong code generation, analysis, and vision capabilities`,
            msg`Widely trusted for production workloads`,
        ],
        tags: [msg`balanced`, msg`versatile`, msg`vision`, msg`coding`],
    },
    "claude-sonnet-4-5": {
        bestFor: msg`Developers who need an updated, capable Claude model with refined reasoning`,
        strengths: [
            msg`Refined capabilities over Claude Sonnet 4`,
            msg`Reliable multi-step reasoning for complex tasks`,
            msg`Strong instruction following across diverse domains`,
        ],
        tags: [msg`balanced`, msg`versatile`, msg`vision`],
    },
    "claude-opus-4": {
        bestFor: msg`Complex analytical tasks requiring frontier intelligence with deep extended thinking`,
        strengths: [
            msg`Frontier-level intelligence from Anthropic`,
            msg`Extended thinking for deep, transparent reasoning chains`,
            msg`Exceptional performance on complex analysis and coding`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`extended thinking`, msg`vision`],
    },
    "claude-opus-4-1": {
        bestFor: msg`Demanding tasks where maximum AI capability and refined reasoning matter most`,
        strengths: [
            msg`Refined frontier capabilities over Claude Opus 4`,
            msg`Deep extended thinking for the most challenging problems`,
            msg`Best-in-class complex reasoning and analysis from Anthropic`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`extended thinking`],
    },
    "claude-sonnet-4-6": {
        bestFor: msg`Developers who need Anthropic's latest updated Sonnet with improved performance`,
        strengths: [
            msg`Latest Sonnet update with improved instruction following`,
            msg`Strong vision and code generation`,
            msg`Best balance of speed and capability in the 4.6 generation`,
        ],
        tags: [msg`balanced`, msg`versatile`, msg`vision`, msg`latest`],
    },
    "claude-opus-4-6": {
        bestFor: msg`The most demanding tasks requiring Anthropic's latest frontier reasoning and capabilities`,
        strengths: [
            msg`Anthropic's latest and most capable Opus model`,
            msg`Advanced extended thinking for the hardest AI tasks`,
            msg`Top-tier frontier performance with 4.6 generation improvements`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`extended thinking`, msg`latest`],
    },
    "claude-opus-4-5": {
        bestFor: msg`Mission-critical AI applications requiring Anthropic's most capable and premium model`,
        strengths: [
            msg`Anthropic's most capable Claude model`,
            msg`Advanced extended thinking for the hardest AI tasks`,
            msg`Premium enterprise-grade performance and reliability`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`premium`, msg`extended thinking`],
    },
    "deepseek-v3": {
        bestFor: msg`Developers who need strong coding and general-purpose capabilities from an open-source model`,
        strengths: [
            msg`Top-tier coding performance rivaling proprietary models`,
            msg`Open-source transparency and reproducibility`,
            msg`Excellent general instruction following`,
        ],
        tags: [msg`coding`, msg`open source`, msg`general purpose`],
    },
    "deepseek-v3-1": {
        bestFor: msg`Production workloads needing DeepSeek's improved chat and reasoning capabilities`,
        strengths: [
            msg`Improved upon DeepSeek V3 with enhanced instruction following`,
            msg`Strong coding capabilities for software development`,
            msg`Efficient inference for production deployments`,
        ],
        tags: [msg`coding`, msg`open source`, msg`general purpose`],
    },
    "deepseek-v3-1-terminus": {
        bestFor: msg`Professional software engineers who need a specialized coding model at open-source cost`,
        strengths: [
            msg`Purpose-built for complex software engineering tasks`,
            msg`Superior multi-file code generation and refactoring`,
            msg`Strong performance on competitive programming benchmarks`,
        ],
        tags: [msg`coding specialist`, msg`software engineering`, msg`open source`],
    },
    "deepseek-v3-2": {
        bestFor: msg`Users wanting the latest generation of DeepSeek's general-purpose chat capabilities`,
        strengths: [
            msg`Latest general-purpose capabilities from DeepSeek`,
            msg`Continued improvement over the V3.1 line`,
            msg`Strong across coding, reasoning, and instruction tasks`,
        ],
        tags: [msg`coding`, msg`general purpose`, msg`latest`],
    },
    "deepseek-r1": {
        bestFor: msg`Complex problems requiring step-by-step reasoning with full transparency into the thinking process`,
        strengths: [
            msg`Full chain-of-thought reasoning visibility`,
            msg`Open-source frontier-level reasoning model`,
            msg`Competitive with closed models on math and coding benchmarks`,
        ],
        tags: [msg`reasoning`, msg`open source`, msg`chain-of-thought`],
    },
    "deepseek-r1-0528": {
        bestFor: msg`Teams that need the latest DeepSeek reasoning improvements with open-source flexibility`,
        strengths: [
            msg`Updated reasoning capabilities over the original R1`,
            msg`Improved benchmark performance on complex tasks`,
            msg`Open weights available for private deployment`,
        ],
        tags: [msg`reasoning`, msg`open source`, msg`updated`],
    },
    "deepseek-r1-distill": {
        bestFor: msg`Efficient reasoning tasks where a distilled model delivers good quality at lower cost`,
        strengths: [
            msg`R1 reasoning distilled into a compact 32B model`,
            msg`Faster inference than the full R1 model`,
            msg`Good reasoning quality at significantly reduced compute cost`,
        ],
        tags: [msg`reasoning`, msg`distilled`, msg`efficient`],
    },
    "gemini-2-0-flash": {
        bestFor: msg`Fast, multimodal tasks requiring Google's efficient Flash model with vision capabilities`,
        strengths: [
            msg`Ultra-fast response times for high-throughput use cases`,
            msg`Strong multimodal understanding with images and code`,
            msg`Google's optimized performance-cost balance`,
        ],
        tags: [msg`fast`, msg`vision`, msg`multimodal`],
    },
    "gemini-2-0-flash-lite": {
        bestFor: msg`Budget-conscious high-volume tasks needing the fastest possible Google AI response`,
        strengths: [
            msg`Fastest and most affordable Gemini variant`,
            msg`Optimized for simple tasks at massive scale`,
            msg`Reliable Google quality at minimal cost`,
        ],
        tags: [msg`ultra fast`, msg`budget`, msg`lightweight`],
    },
    "gemini-2-5-flash": {
        bestFor: msg`Developers who need an improved, fast Google model with stronger reasoning`,
        strengths: [
            msg`Improved reasoning over Gemini 2.0 Flash`,
            msg`Strong multimodal capabilities including vision`,
            msg`Efficient performance for production deployments`,
        ],
        tags: [msg`fast`, msg`vision`, msg`multimodal`],
    },
    "gemini-2-5-flash-lite": {
        bestFor: msg`Cost-sensitive applications needing reliable Google AI at the lowest Gemini 2.5 tier`,
        strengths: [msg`Lowest-cost Gemini 2.5 model`, msg`Fast response for simple tasks`, msg`Google reliability at budget pricing`],
        tags: [msg`ultra fast`, msg`budget`, msg`Google`],
    },
    "gemini-2-5-pro": {
        bestFor: msg`Complex tasks requiring frontier reasoning, long-context understanding, and multimodal Google AI`,
        strengths: [
            msg`Frontier-level intelligence from Google DeepMind`,
            msg`Exceptional long-context handling up to millions of tokens`,
            msg`Advanced reasoning and coding capabilities`,
        ],
        tags: [msg`frontier`, msg`long context`, msg`vision`, msg`reasoning`],
    },
    "gemini-3-flash": {
        bestFor: msg`Early adopters who want to experiment with Google's next-generation Flash capabilities`,
        strengths: [
            msg`Next-generation Google AI architecture`,
            msg`Fast response with improved quality over 2.x Flash`,
            msg`Preview access to future Gemini capabilities`,
        ],
        tags: [msg`fast`, msg`next-gen`, msg`preview`],
    },
    "gemini-3-pro": {
        bestFor: msg`Researchers and early adopters exploring Google's most advanced next-generation AI`,
        strengths: [
            msg`Cutting-edge Google frontier AI capabilities`,
            msg`Significant capability improvements over Gemini 2.5 Pro`,
            msg`Preview of Google's most powerful model generation`,
        ],
        tags: [msg`frontier`, msg`next-gen`, msg`preview`],
    },
    "gemini-3-1-pro": {
        bestFor: msg`Teams who need Google's newest flagship model with advanced reasoning at the frontier tier`,
        strengths: [
            msg`Google's newest flagship model with advanced reasoning`,
            msg`Significant improvements over Gemini 3 Pro`,
            msg`Premium frontier intelligence for demanding applications`,
        ],
        tags: [msg`frontier`, msg`reasoning`, msg`premium`, msg`latest`],
    },
    "gpt-5": {
        bestFor: msg`Demanding applications that require OpenAI's latest frontier model capabilities`,
        strengths: [
            msg`OpenAI's most advanced frontier model`,
            msg`Substantially improved reasoning, vision, and instruction following`,
            msg`Flagship performance for enterprise use cases`,
        ],
        tags: [msg`frontier`, msg`vision`, msg`latest`],
    },
    "gpt-5-mini": {
        bestFor: msg`Production workloads needing GPT-5 quality at a faster, more affordable tier`,
        strengths: [
            msg`GPT-5 architecture in a faster, more affordable size`,
            msg`Solid performance across most task types`,
            msg`Better speed-to-quality ratio than the full GPT-5`,
        ],
        tags: [msg`balanced`, msg`vision`, msg`efficient`],
    },
    "gpt-5-nano": {
        bestFor: msg`High-volume automation needing reliable OpenAI quality at maximum speed and minimal cost`,
        strengths: [
            msg`Ultra-fast GPT-5 family member for batch tasks`,
            msg`Minimal cost for simple classification and extraction`,
            msg`OpenAI reliability at smallest model scale`,
        ],
        tags: [msg`ultra fast`, msg`budget`, msg`lightweight`],
    },
    "gpt-5-1": {
        bestFor: msg`Teams who need a refined GPT-5 update with improved instruction following and reasoning`,
        strengths: [
            msg`Refined GPT-5 with improved instruction following`,
            msg`Strong vision and code generation capabilities`,
            msg`Updated OpenAI frontier performance`,
        ],
        tags: [msg`frontier`, msg`vision`, msg`refined`],
    },
    "gpt-5-2": {
        bestFor: msg`Developers tracking the latest OpenAI improvements for frontier-quality reasoning`,
        strengths: [
            msg`Latest in the GPT-5 family with continued improvements`,
            msg`Excellent at complex multi-step reasoning`,
            msg`State-of-the-art OpenAI quality`,
        ],
        tags: [msg`frontier`, msg`vision`, msg`latest`],
    },
    "gpt-5-2-pro": {
        bestFor: msg`Enterprise deployments requiring OpenAI's most premium, capable model`,
        strengths: [
            msg`OpenAI's most capable model in the 5.2 family`,
            msg`Premium-tier reasoning and instruction following`,
            msg`Best-in-class for demanding enterprise use cases`,
        ],
        tags: [msg`frontier`, msg`premium`, msg`vision`],
    },
    "qwen3-235b": {
        bestFor: msg`Demanding tasks requiring one of the world's largest open-source AI models from Alibaba`,
        strengths: [
            msg`235B parameter Mixture-of-Experts architecture`,
            msg`Frontier-level performance across reasoning and coding`,
            msg`Open-source access to state-of-the-art Alibaba AI`,
        ],
        tags: [msg`MoE`, msg`massive`, msg`open source`],
    },
    "qwen3-235b-thinking": {
        bestFor: msg`Complex problems where the largest Qwen model's extended chain-of-thought reasoning is needed`,
        strengths: [
            msg`Extended thinking mode on the largest Qwen model`,
            msg`Exceptional chain-of-thought reasoning quality`,
            msg`Top-tier open-source reasoning capabilities`,
        ],
        tags: [msg`reasoning`, msg`MoE`, msg`chain-of-thought`],
    },
    "qwen3-coder": {
        bestFor: msg`Software developers who need a specialized coding model built on Alibaba's Qwen3 architecture`,
        strengths: [
            msg`Purpose-optimized for code generation and debugging`,
            msg`Strong support for many programming languages`,
            msg`High code quality from Alibaba's specialized training`,
        ],
        tags: [msg`coding specialist`, msg`software engineering`, msg`open source`],
    },
    "qwen3-32b-or": {
        bestFor: msg`General-purpose tasks needing a capable, balanced model from the Qwen3 family`,
        strengths: [
            msg`Strong performance across diverse task types`,
            msg`Good reasoning with efficient 32B scale`,
            msg`Accessible Qwen3 quality for production use`,
        ],
        tags: [msg`balanced`, msg`reasoning`, msg`general purpose`],
    },
    "minimax-m2": {
        bestFor: msg`Multimodal tasks where MiniMax's M2 delivers reliable vision and text understanding`,
        strengths: [
            msg`Strong multimodal vision capabilities`,
            msg`Long-context understanding for document analysis`,
            msg`MiniMax's advanced production model`,
        ],
        tags: [msg`multimodal`, msg`vision`, msg`long context`],
    },
    "minimax-m2-1": {
        bestFor: msg`Teams needing MiniMax's latest and most capable multimodal model`,
        strengths: [msg`Updated M2 architecture with improved capabilities`, msg`Enhanced vision and reasoning`, msg`MiniMax's most refined production model`],
        tags: [msg`multimodal`, msg`vision`, msg`updated`],
    },
    "kimi-k2": {
        bestFor: msg`Long-document analysis and research tasks where Kimi K2's extended context shines`,
        strengths: [
            msg`Extended context window for long-document processing`,
            msg`Strong chat and question-answering performance`,
            msg`Moonshot AI's flagship conversation model`,
        ],
        tags: [msg`long context`, msg`chat`, msg`research`],
    },
    "kimi-k2-thinking": {
        bestFor: msg`Complex reasoning tasks that benefit from Kimi K2's thinking capabilities and extended context`,
        strengths: [
            msg`Extended chain-of-thought reasoning with long context`,
            msg`Deep thinking mode for difficult analytical problems`,
            msg`Frontier-level reasoning from Moonshot AI`,
        ],
        tags: [msg`reasoning`, msg`long context`, msg`chain-of-thought`],
    },
    "llama-3-3-70b": {
        bestFor: msg`Open-source AI deployments requiring capable, unrestricted access to Meta's Llama 3.3`,
        strengths: [
            msg`Fully open-source with permissive license`,
            msg`Strong instruction following and general reasoning`,
            msg`Meta's well-established and widely-deployed model`,
        ],
        tags: [msg`open source`, msg`versatile`, msg`general purpose`],
    },
    "llama-4-maverick": {
        bestFor: msg`Multimodal open-source tasks where Meta's Llama 4 vision capabilities are needed`,
        strengths: [
            msg`Meta's latest open-source model with multimodal vision`,
            msg`Strong vision understanding alongside text generation`,
            msg`Open weights for flexible deployment options`,
        ],
        tags: [msg`open source`, msg`multimodal`, msg`vision`],
    },
    "glm-4-5": {
        bestFor: msg`General-purpose tasks requiring Z.AI's powerful GLM 4.5 language model`,
        strengths: [
            msg`Strong performance across diverse text tasks`,
            msg`Z.AI's general-purpose frontier model`,
            msg`Excellent multilingual capability including Chinese`,
        ],
        tags: [msg`general purpose`, msg`multilingual`, msg`Z.AI`],
    },
    "glm-4-5v": {
        bestFor: msg`Multimodal tasks requiring Z.AI's vision-capable GLM model for image and text understanding`,
        strengths: [
            msg`Vision understanding alongside strong text capabilities`,
            msg`Multimodal analysis for images and documents`,
            msg`Z.AI's vision-enhanced flagship model`,
        ],
        tags: [msg`vision`, msg`multimodal`, msg`Z.AI`],
    },
    "glm-4-5-air": {
        bestFor: msg`High-speed tasks needing Z.AI's lightweight, efficient GLM model at lower cost`,
        strengths: [
            msg`Faster and lighter than the full GLM 4.5`,
            msg`Good performance for simple to medium complexity tasks`,
            msg`Cost-efficient Z.AI model for high-volume use cases`,
        ],
        tags: [msg`fast`, msg`efficient`, msg`affordable`],
    },
    "glm-4-6": {
        bestFor: msg`Teams who want Z.AI's latest GLM capabilities with improved reasoning`,
        strengths: [
            msg`Updated capabilities over GLM 4.5`,
            msg`Continued improvements in reasoning and instruction following`,
            msg`Z.AI's latest general-purpose model`,
        ],
        tags: [msg`updated`, msg`general purpose`, msg`Z.AI`],
    },
    "glm-4-6v": {
        bestFor: msg`Vision tasks needing Z.AI's updated and improved multimodal capabilities`,
        strengths: [
            msg`Enhanced vision understanding over GLM 4.5v`,
            msg`Improved multimodal reasoning`,
            msg`Z.AI's latest vision model with broader capability`,
        ],
        tags: [msg`vision`, msg`multimodal`, msg`updated`],
    },
    "glm-4-7": {
        bestFor: msg`Demanding tasks requiring Z.AI's most powerful and capable frontier GLM model`,
        strengths: [
            msg`Z.AI's frontier model with top-tier performance`,
            msg`Strongest reasoning in the GLM family`,
            msg`Best-in-class Chinese-origin frontier AI model`,
        ],
        tags: [msg`frontier`, msg`Z.AI`, msg`powerful`],
    },
    "grok-3": {
        bestFor: msg`Tasks requiring xAI's vision capabilities and real-time information access via Grok 3`,
        strengths: [
            msg`xAI's capable balanced model with vision support`,
            msg`Strong reasoning across diverse domains`,
            msg`Access to real-time information from X/Twitter data`,
        ],
        tags: [msg`vision`, msg`real-time web`, msg`xAI`],
    },
    "grok-4": {
        bestFor: msg`Frontier AI tasks requiring xAI's most powerful reasoning and vision capabilities`,
        strengths: [
            msg`xAI's flagship frontier model with advanced reasoning`,
            msg`Strong vision and multimodal capabilities`,
            msg`Top-tier performance on coding and STEM benchmarks`,
        ],
        tags: [msg`frontier`, msg`reasoning`, msg`vision`],
    },
    "grok-4-1-fast": {
        bestFor: msg`Fast, efficient agentic tasks requiring xAI's latest tool-calling and real-time capabilities`,
        strengths: [
            msg`xAI's best agentic tool-calling model`,
            msg`2M token context window with fast inference`,
            msg`Reasoning toggle for flexible task handling`,
        ],
        tags: [msg`fast`, msg`agentic`, msg`tool calling`, msg`vision`],
    },
    "grok-4-1-fast-thinking": {
        bestFor: msg`Fast reasoning tasks requiring xAI's latest model with transparent chain-of-thought`,
        strengths: [
            msg`Reasoning-enabled version of Grok 4.1 Fast`,
            msg`Fast inference with deep thinking capabilities`,
            msg`2M context window with multimodal support`,
        ],
        tags: [msg`fast`, msg`reasoning`, msg`vision`],
    },
    "grok-3-mini": {
        bestFor: msg`Lightweight reasoning tasks where xAI's smallest model provides the best cost-efficiency`,
        strengths: [msg`xAI's most compact reasoning model`, msg`Good reasoning at minimal cost`, msg`Vision support with efficient inference`],
        tags: [msg`reasoning`, msg`compact`, msg`efficient`],
    },
    "grok-4-fast": {
        bestFor: msg`High-throughput multimodal tasks requiring fast xAI inference at low cost`,
        strengths: [
            msg`SOTA cost-efficiency with 2M token context`,
            msg`Fast multimodal inference with vision support`,
            msg`Flexible reasoning toggle for task-specific optimization`,
        ],
        tags: [msg`fast`, msg`vision`, msg`cost-efficient`],
    },
    "grok-4-fast-thinking": {
        bestFor: msg`Reasoning-intensive tasks that need fast xAI inference with transparent thinking`,
        strengths: [msg`Reasoning-enabled fast multimodal model`, msg`Chain-of-thought transparency at speed`, msg`Vision and tool-calling support`],
        tags: [msg`fast`, msg`reasoning`, msg`vision`],
    },
    "grok-code": {
        bestFor: msg`Software development tasks requiring xAI's specialized coding model`,
        strengths: [
            msg`Purpose-built for agentic coding workflows`,
            msg`Fast reasoning optimized for code generation`,
            msg`Strong multi-file editing and debugging`,
        ],
        tags: [msg`coding`, msg`fast`, msg`reasoning`],
    },
    "claude-sonnet-4-5-thinking": {
        bestFor: msg`Tasks requiring Anthropic's balanced model with transparent chain-of-thought reasoning`,
        strengths: [
            msg`Thinking mode reveals Anthropic's reasoning process`,
            msg`Strong balance of speed and intelligence`,
            msg`Excellent for complex multi-step analysis`,
        ],
        tags: [msg`reasoning`, msg`balanced`, msg`vision`],
    },
    "claude-sonnet-4-6-thinking": {
        bestFor: msg`Latest Sonnet with transparent reasoning for complex analytical tasks`,
        strengths: [
            msg`Anthropic's latest Sonnet with thinking capability`,
            msg`Improved instruction following with reasoning transparency`,
            msg`Strong vision and coding with chain-of-thought`,
        ],
        tags: [msg`reasoning`, msg`balanced`, msg`vision`, msg`latest`],
    },
    "claude-opus-4-5-thinking": {
        bestFor: msg`The most demanding analytical tasks requiring Anthropic's premium reasoning`,
        strengths: [
            msg`Extended thinking on Anthropic's most capable Opus`,
            msg`Premium-tier reasoning transparency`,
            msg`Best-in-class for complex multi-step problems`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`premium`],
    },
    "claude-opus-4-6-thinking": {
        bestFor: msg`Frontier reasoning tasks requiring Anthropic's latest and most advanced thinking capabilities`,
        strengths: [
            msg`Anthropic's latest Opus with full thinking transparency`,
            msg`Most advanced extended reasoning in the Claude family`,
            msg`Top-tier performance on the hardest AI benchmarks`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`latest`],
    },
    "deepseek-v3-2-thinking": {
        bestFor: msg`Complex problems requiring DeepSeek V3.2's reasoning with transparent chain-of-thought`,
        strengths: [
            msg`Thinking mode on DeepSeek's latest chat model`,
            msg`Strong reasoning at open-source cost`,
            msg`Competitive with closed models on reasoning benchmarks`,
        ],
        tags: [msg`reasoning`, msg`open source`, msg`chain-of-thought`],
    },
    "deepseek-v3-2-exp": {
        bestFor: msg`Users exploring DeepSeek's experimental capabilities ahead of stable releases`,
        strengths: [
            msg`Cutting-edge experimental features from DeepSeek`,
            msg`Preview of next-generation capabilities`,
            msg`Strong general-purpose performance`,
        ],
        tags: [msg`experimental`, msg`general purpose`],
    },
    "deepseek-v3-2-exp-thinking": {
        bestFor: msg`Experimental reasoning with DeepSeek's latest thinking capabilities`,
        strengths: [
            msg`Thinking-enabled experimental DeepSeek model`,
            msg`Transparent reasoning chain exploration`,
            msg`Preview of next-gen reasoning capabilities`,
        ],
        tags: [msg`reasoning`, msg`experimental`],
    },
    "gemini-2-5-flash-thinking": {
        bestFor: msg`Fast reasoning tasks requiring Google's efficient Flash model with transparent thinking`,
        strengths: [msg`Thinking mode on Google's fast Flash model`, msg`Efficient reasoning at low cost`, msg`Vision and PDF support with chain-of-thought`],
        tags: [msg`fast`, msg`reasoning`, msg`vision`],
    },
    "gemini-2-5-pro-thinking": {
        bestFor: msg`Complex reasoning requiring Google's frontier model with extended thinking capabilities`,
        strengths: [
            msg`Full thinking transparency on Gemini 2.5 Pro`,
            msg`Frontier reasoning with long-context support`,
            msg`Exceptional performance on complex analytical tasks`,
        ],
        tags: [msg`frontier`, msg`reasoning`, msg`long context`],
    },
    "gemini-3-flash-thinking": {
        bestFor: msg`Next-gen fast reasoning from Google's latest Flash architecture with thinking mode`,
        strengths: [
            msg`Google's next-gen Flash with reasoning transparency`,
            msg`Fast inference with chain-of-thought capability`,
            msg`Preview of future Gemini capabilities with thinking`,
        ],
        tags: [msg`fast`, msg`reasoning`, msg`next-gen`],
    },
    "gpt-4-1": {
        bestFor: msg`Advanced instruction-following tasks with strong vision and reasoning from OpenAI`,
        strengths: [
            msg`Strong instruction following and reasoning`,
            msg`Excellent vision and PDF comprehension`,
            msg`Reliable performance across diverse domains`,
        ],
        tags: [msg`vision`, msg`reasoning`, msg`versatile`],
    },
    "gpt-4-1-mini": {
        bestFor: msg`Efficient production tasks needing GPT-4.1 quality at a faster, smaller scale`,
        strengths: [msg`GPT-4.1 architecture in a compact form`, msg`Fast inference with vision and PDF support`, msg`Good balance of cost and capability`],
        tags: [msg`fast`, msg`vision`, msg`efficient`],
    },
    "gpt-4-1-nano": {
        bestFor: msg`High-volume lightweight tasks needing OpenAI's smallest and fastest model`,
        strengths: [
            msg`OpenAI's smallest model for maximum speed`,
            msg`Vision and PDF support at minimal cost`,
            msg`Ideal for simple classification and extraction`,
        ],
        tags: [msg`budget`, msg`fast`, msg`vision`],
    },
    o3: {
        bestFor: msg`Complex reasoning tasks requiring OpenAI's most capable dedicated reasoning model`,
        strengths: [
            msg`OpenAI's advanced reasoning architecture`,
            msg`Exceptional performance on math and coding benchmarks`,
            msg`Strong vision and multi-step problem solving`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`vision`],
    },
    "o4-mini": {
        bestFor: msg`Efficient reasoning tasks where OpenAI's compact reasoning model delivers strong results`,
        strengths: [msg`OpenAI's efficient mini reasoning model`, msg`Good reasoning at reduced cost`, msg`Vision and PDF support with chain-of-thought`],
        tags: [msg`reasoning`, msg`fast`, msg`vision`],
    },
    "gpt-5-medium": {
        bestFor: msg`Demanding tasks requiring OpenAI's latest flagship reasoning capabilities`,
        strengths: [msg`OpenAI's latest flagship reasoning LLM`, msg`Advanced vision and multi-step reasoning`, msg`Strong performance across STEM and coding`],
        tags: [msg`frontier`, msg`reasoning`, msg`vision`],
    },
    "gpt-5-1-thinking": {
        bestFor: msg`Complex reasoning requiring GPT-5.1's transparent thinking process`,
        strengths: [
            msg`Thinking-enabled version of GPT-5.1`,
            msg`Transparent chain-of-thought reasoning`,
            msg`Strong vision and PDF comprehension with reasoning`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`vision`],
    },
    "gpt-5-2-thinking": {
        bestFor: msg`Latest OpenAI reasoning with GPT-5.2's transparent thinking capabilities`,
        strengths: [
            msg`OpenAI's latest model with thinking transparency`,
            msg`Top-tier reasoning on complex benchmarks`,
            msg`Full vision and PDF support with chain-of-thought`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`latest`],
    },
    "gpt-5-codex": {
        bestFor: msg`Professional software development requiring OpenAI's specialized coding model`,
        strengths: [
            msg`Purpose-built for complex software engineering`,
            msg`Strong multi-file code generation and debugging`,
            msg`Vision support for understanding code screenshots`,
        ],
        tags: [msg`coding`, msg`reasoning`, msg`vision`],
    },
    "gpt-5-1-codex": {
        bestFor: msg`Advanced coding tasks requiring OpenAI's refined Codex capabilities`,
        strengths: [msg`Updated Codex with improved code quality`, msg`Strong reasoning for complex software tasks`, msg`Vision-enabled code comprehension`],
        tags: [msg`coding`, msg`reasoning`, msg`refined`],
    },
    "gpt-5-1-codex-mini": {
        bestFor: msg`Efficient coding tasks needing Codex quality in a compact model`,
        strengths: [
            msg`Compact Codex model for faster code generation`,
            msg`Good coding quality at reduced cost`,
            msg`Reasoning support for debugging and analysis`,
        ],
        tags: [msg`coding`, msg`efficient`, msg`reasoning`],
    },
    "gpt-5-1-codex-max": {
        bestFor: msg`The most demanding software engineering tasks requiring OpenAI's maximum coding capability`,
        strengths: [
            msg`OpenAI's most capable coding model`,
            msg`Premium-tier code generation and analysis`,
            msg`Maximum reasoning depth for complex architectures`,
        ],
        tags: [msg`coding`, msg`premium`, msg`frontier`],
    },
    "gpt-5-2-codex": {
        bestFor: msg`Latest-generation coding requiring OpenAI's newest Codex model`,
        strengths: [
            msg`Latest Codex generation with improved capabilities`,
            msg`Strong performance on competitive coding benchmarks`,
            msg`Advanced multi-file reasoning and generation`,
        ],
        tags: [msg`coding`, msg`latest`, msg`reasoning`],
    },
    "gpt-5-3-codex": {
        bestFor: msg`Cutting-edge coding with OpenAI's newest Codex generation`,
        strengths: [msg`OpenAI's newest coding model`, msg`State-of-the-art code generation quality`, msg`Advanced agentic coding capabilities`],
        tags: [msg`coding`, msg`newest`, msg`frontier`],
    },
    "gpt-oss-20b": {
        bestFor: msg`Open-source projects needing OpenAI's small, fast, and accessible model`,
        strengths: [msg`OpenAI's open-source 20B model`, msg`Fast inference at minimal cost`, msg`Good quality for simple tasks and automation`],
        tags: [msg`open source`, msg`fast`, msg`budget`],
    },
    "gpt-oss-120b": {
        bestFor: msg`Open-source deployments requiring OpenAI's larger, more capable OSS model`,
        strengths: [msg`OpenAI's advanced 120B open-source model`, msg`Strong performance across diverse tasks`, msg`Open weights for flexible deployment`],
        tags: [msg`open source`, msg`capable`, msg`versatile`],
    },
    "qwen3-32b-thinking": {
        bestFor: msg`Efficient reasoning tasks using Alibaba's balanced 32B model with thinking capability`,
        strengths: [
            msg`Thinking mode on an efficient 32B model`,
            msg`Good reasoning quality at moderate scale`,
            msg`Cost-effective chain-of-thought reasoning`,
        ],
        tags: [msg`reasoning`, msg`efficient`, msg`balanced`],
    },
    "qwen3-4b": {
        bestFor: msg`Ultra-lightweight tasks requiring Alibaba's smallest Qwen3 model`,
        strengths: [msg`Alibaba's smallest and fastest Qwen3 model`, msg`Minimal cost for simple tasks`, msg`Good quality at 4B parameter scale`],
        tags: [msg`budget`, msg`fast`, msg`lightweight`],
    },
    "qwen3-4b-thinking": {
        bestFor: msg`Lightweight reasoning tasks with Alibaba's small model and thinking capability`,
        strengths: [
            msg`Reasoning-enabled at just 4B parameters`,
            msg`Cost-effective chain-of-thought capability`,
            msg`Compact model with transparent thinking`,
        ],
        tags: [msg`reasoning`, msg`budget`, msg`compact`],
    },
    "qwen3-coder-30b": {
        bestFor: msg`Coding tasks requiring Alibaba's specialized 30B coding model`,
        strengths: [msg`Alibaba's advanced coding-specialized model`, msg`Strong multi-language code generation`, msg`Efficient 30B scale for code tasks`],
        tags: [msg`coding`, msg`efficient`, msg`specialized`],
    },
    "qwen3-coder-plus": {
        bestFor: msg`Complex software engineering requiring Alibaba's most advanced coding model`,
        strengths: [
            msg`Alibaba's most capable coding LLM`,
            msg`Frontier-level code generation and analysis`,
            msg`Strong performance on competitive coding benchmarks`,
        ],
        tags: [msg`coding`, msg`frontier`, msg`advanced`],
    },
    "qwen3-coder-next": {
        bestFor: msg`Agentic coding workflows requiring Alibaba's next-gen code model with MoE efficiency`,
        strengths: [
            msg`Next-gen sparse MoE design with only 3B activated`,
            msg`Strong agentic focus for long-horizon coding`,
            msg`Native 256K context window for large codebases`,
        ],
        tags: [msg`coding`, msg`agentic`, msg`MoE`],
    },
    "qwen3-5-397b": {
        bestFor: msg`Frontier tasks requiring Alibaba's largest and most capable Qwen3.5 model`,
        strengths: [
            msg`Alibaba's latest flagship 397B MoE model`,
            msg`State-of-the-art performance across all benchmarks`,
            msg`Vision and reasoning capabilities`,
        ],
        tags: [msg`frontier`, msg`MoE`, msg`vision`, msg`reasoning`],
    },
    "qwen3-5-plus": {
        bestFor: msg`High-capability tasks requiring Alibaba's latest flagship with vision and reasoning`,
        strengths: [
            msg`Alibaba's latest flagship with full capabilities`,
            msg`Strong vision and reasoning integration`,
            msg`Top-tier performance in the Qwen 3.5 family`,
        ],
        tags: [msg`frontier`, msg`vision`, msg`reasoning`],
    },
    "qwen3-5-flash": {
        bestFor: msg`Fast vision tasks requiring Alibaba's efficient Qwen3.5 Flash model`,
        strengths: [msg`Fast inference from Qwen3.5 family`, msg`Vision capabilities at speed`, msg`Efficient for high-throughput multimodal tasks`],
        tags: [msg`fast`, msg`vision`, msg`efficient`],
    },
    "qwen3-vl-30b": {
        bestFor: msg`Vision-language tasks requiring Alibaba's efficient 30B multimodal model`,
        strengths: [msg`Strong vision understanding at 30B scale`, msg`Efficient multimodal reasoning`, msg`Good balance of visual quality and speed`],
        tags: [msg`vision`, msg`efficient`, msg`multimodal`],
    },
    "qwen3-vl-30b-thinking": {
        bestFor: msg`Vision reasoning tasks requiring transparent thinking on Alibaba's 30B VL model`,
        strengths: [msg`Thinking-enabled vision-language model`, msg`Transparent reasoning over visual inputs`, msg`Efficient multimodal chain-of-thought`],
        tags: [msg`vision`, msg`reasoning`, msg`efficient`],
    },
    "qwen3-next-80b": {
        bestFor: msg`Production tasks requiring Alibaba's advanced 80B MoE instruct model`,
        strengths: [msg`Advanced 80B MoE architecture`, msg`Strong instruction following`, msg`Only 3B activated per token for efficiency`],
        tags: [msg`MoE`, msg`efficient`, msg`instruct`],
    },
    "qwen3-next-80b-thinking": {
        bestFor: msg`Reasoning tasks requiring Alibaba's 80B MoE model with thinking capability`,
        strengths: [msg`Thinking-enabled 80B MoE architecture`, msg`Transparent chain-of-thought reasoning`, msg`Efficient reasoning with sparse activation`],
        tags: [msg`reasoning`, msg`MoE`, msg`efficient`],
    },
    "qwen3-max": {
        bestFor: msg`Demanding tasks requiring Alibaba's most advanced instruct-optimized model`,
        strengths: [
            msg`Alibaba's most advanced instruct LLM`,
            msg`Major improvements in reasoning and instruction following`,
            msg`Strong multilingual support and long-tail knowledge`,
        ],
        tags: [msg`frontier`, msg`instruct`, msg`multilingual`],
    },
    "qwen3-max-preview": {
        bestFor: msg`Early access to Alibaba's upcoming model capabilities`,
        strengths: [
            msg`Preview access to Qwen's most advanced model`,
            msg`Exploring next-gen capabilities before stable release`,
            msg`Strong across reasoning, coding, and general tasks`,
        ],
        tags: [msg`frontier`, msg`preview`, msg`versatile`],
    },
    "qwen3-max-thinking": {
        bestFor: msg`The most complex reasoning tasks requiring Alibaba's most advanced thinking model`,
        strengths: [
            msg`Qwen's most advanced reasoning capability`,
            msg`Deep chain-of-thought on frontier-class model`,
            msg`Top-tier performance on reasoning benchmarks`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`advanced`],
    },
    "qwen3-vl": {
        bestFor: msg`Advanced vision-language tasks requiring Alibaba's full-scale VL model with reasoning`,
        strengths: [
            msg`Alibaba's most capable vision-language model`,
            msg`Strong visual reasoning and understanding`,
            msg`256K context with multimodal support`,
        ],
        tags: [msg`vision`, msg`reasoning`, msg`frontier`],
    },
    "qwen3-vl-thinking": {
        bestFor: msg`Complex visual reasoning requiring transparent thinking over visual inputs`,
        strengths: [
            msg`Full thinking transparency on Alibaba's flagship VL model`,
            msg`Deep visual reasoning with chain-of-thought`,
            msg`Advanced multimodal analysis capabilities`,
        ],
        tags: [msg`vision`, msg`reasoning`, msg`chain-of-thought`],
    },
    "minimax-m1-80k": {
        bestFor: msg`Long-context reasoning tasks requiring MiniMax's 80K context model`,
        strengths: [msg`MiniMax's advanced reasoning model`, msg`80K token context for long document analysis`, msg`Strong reasoning across diverse domains`],
        tags: [msg`reasoning`, msg`long context`, msg`analysis`],
    },
    "minimax-m2-1-lightning": {
        bestFor: msg`High-throughput production tasks needing MiniMax's fastest reasoning model`,
        strengths: [
            msg`MiniMax's fastest model with reasoning capability`,
            msg`Lightning-fast inference at production scale`,
            msg`Strong reasoning quality at speed`,
        ],
        tags: [msg`reasoning`, msg`fast`, msg`production`],
    },
    "minimax-m2-5": {
        bestFor: msg`The most demanding AI tasks requiring MiniMax's most capable model`,
        strengths: [
            msg`MiniMax's most capable reasoning LLM`,
            msg`#1 on OpenRouter by token usage`,
            msg`Leading performance on coding, agents, and office tasks`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`agents`],
    },
    "kimi-k2-5": {
        bestFor: msg`Complex vision and reasoning tasks requiring Moonshot AI's latest multi-modal model`,
        strengths: [
            msg`Moonshot AI's latest vision-enabled flagship`,
            msg`Strong reasoning with multimodal support`,
            msg`Frontier-level intelligence from Kimi K2.5`,
        ],
        tags: [msg`vision`, msg`reasoning`, msg`frontier`],
    },
    "kimi-k2-5-thinking": {
        bestFor: msg`Deep reasoning tasks with Kimi K2.5's transparent thinking capability`,
        strengths: [
            msg`Thinking-enabled version of Kimi K2.5`,
            msg`Transparent chain-of-thought with vision support`,
            msg`Frontier reasoning from Moonshot AI`,
        ],
        tags: [msg`reasoning`, msg`vision`, msg`chain-of-thought`],
    },
    "kimi-k2-0905": {
        bestFor: msg`Fast, capable tasks using Moonshot AI's optimized base model`,
        strengths: [msg`Moonshot AI's efficient base model`, msg`Fast inference for production use`, msg`Strong general-purpose capabilities`],
        tags: [msg`fast`, msg`general purpose`, msg`efficient`],
    },
    "glm-4-6v-flash": {
        bestFor: msg`Fast vision reasoning requiring Z.AI's efficient flash-speed model`,
        strengths: [msg`Z.AI's fastest vision model`, msg`Reasoning capability at flash speed`, msg`Efficient for high-throughput visual tasks`],
        tags: [msg`fast`, msg`vision`, msg`reasoning`],
    },
    "glm-4-7-flash": {
        bestFor: msg`Fast vision reasoning from Z.AI's latest flash model generation`,
        strengths: [msg`Z.AI's latest fast vision reasoning model`, msg`Improved quality over GLM 4.6V Flash`, msg`Efficient multimodal processing at speed`],
        tags: [msg`fast`, msg`vision`, msg`reasoning`, msg`latest`],
    },
    "glm-5": {
        bestFor: msg`Complex system design and agentic coding requiring Z.AI's most powerful model`,
        strengths: [
            msg`Z.AI's most powerful flagship model`,
            msg`Built for expert developers and complex systems`,
            msg`Advanced agentic planning and self-correction`,
        ],
        tags: [msg`frontier`, msg`coding`, msg`agentic`],
    },
    "glm-5-thinking": {
        bestFor: msg`The most demanding reasoning tasks requiring Z.AI's frontier model with thinking`,
        strengths: [
            msg`Thinking-enabled version of GLM 5`,
            msg`Transparent chain-of-thought on Z.AI's flagship`,
            msg`Deep reasoning for complex analytical problems`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`chain-of-thought`],
    },
    "devstral-2": {
        bestFor: msg`Coding tasks requiring Mistral's specialized development-focused model`,
        strengths: [
            msg`Mistral's coding-focused LLM`,
            msg`Strong multi-file orchestration and framework awareness`,
            msg`Failure recovery for robust code generation`,
        ],
        tags: [msg`coding`, msg`developer tools`, msg`robust`],
    },
    "devstral-small-2": {
        bestFor: msg`Lightweight coding tasks needing Mistral's compact development model`,
        strengths: [msg`Compact coding model from Mistral`, msg`Fast inference for code generation`, msg`Good quality at smaller scale`],
        tags: [msg`coding`, msg`fast`, msg`compact`],
    },
    "ministral-3-3b": {
        bestFor: msg`Edge and on-device deployment requiring Mistral's smallest multi-modal model`,
        strengths: [msg`Mistral's smallest 3B multi-modal model`, msg`Optimized for edge and mobile deployment`, msg`Vision and PDF support at minimal size`],
        tags: [msg`vision`, msg`compact`, msg`edge`],
    },
    "ministral-3-8b": {
        bestFor: msg`Efficient multi-modal tasks needing Mistral's 8B model with vision capabilities`,
        strengths: [
            msg`Powerful 8B model with vision capabilities`,
            msg`Strong performance for its parameter count`,
            msg`Efficient for production multi-modal tasks`,
        ],
        tags: [msg`vision`, msg`efficient`, msg`multimodal`],
    },
    "ministral-3-14b": {
        bestFor: msg`Production tasks requiring Mistral's 14B model for high-quality multi-modal results`,
        strengths: [
            msg`Mistral's largest Ministral model at 14B`,
            msg`Performance comparable to Mistral Small 24B`,
            msg`Strong multi-modal capabilities with PDF support`,
        ],
        tags: [msg`vision`, msg`high quality`, msg`multimodal`],
    },
    "mistral-large-3": {
        bestFor: msg`Demanding tasks requiring Mistral's most capable large model with MoE efficiency`,
        strengths: [
            msg`Mistral's most capable model with 675B total parameters`,
            msg`Sparse MoE with 41B active for efficiency`,
            msg`Apache 2.0 licensed for open deployment`,
        ],
        tags: [msg`frontier`, msg`MoE`, msg`open source`],
    },
    "mistral-medium": {
        bestFor: msg`Balanced tasks requiring Mistral's mid-tier multi-modal capabilities`,
        strengths: [msg`Mistral's balanced medium model`, msg`Vision and PDF comprehension support`, msg`Good quality-to-cost ratio for production use`],
        tags: [msg`balanced`, msg`vision`, msg`multimodal`],
    },
    "magistral-small": {
        bestFor: msg`Efficient reasoning tasks requiring Mistral's compact reasoning model`,
        strengths: [msg`Mistral's 24B reasoning model`, msg`Trained with RL on reasoning traces`, msg`Supports 20+ languages with vision and PDF`],
        tags: [msg`reasoning`, msg`efficient`, msg`multilingual`],
    },
    "magistral-medium": {
        bestFor: msg`Complex reasoning requiring Mistral's dedicated reasoning model at frontier quality`,
        strengths: [
            msg`Mistral's first dedicated reasoning model`,
            msg`Multi-step reasoning for complex analysis`,
            msg`Transparent thinking for legal, financial, and technical tasks`,
        ],
        tags: [msg`reasoning`, msg`frontier`, msg`analytical`],
    },
    "command-a": {
        bestFor: msg`Enterprise tasks requiring Cohere's advanced command-following model`,
        strengths: [
            msg`Cohere's most capable command model`,
            msg`Strong instruction following for business tasks`,
            msg`Enterprise-grade reliability and quality`,
        ],
        tags: [msg`enterprise`, msg`instruct`, msg`reliable`],
    },
    "command-a-thinking": {
        bestFor: msg`Complex enterprise reasoning requiring Cohere's command model with thinking`,
        strengths: [
            msg`Thinking-enabled Cohere command model`,
            msg`Transparent reasoning for business analysis`,
            msg`Enterprise-grade quality with chain-of-thought`,
        ],
        tags: [msg`reasoning`, msg`enterprise`, msg`analytical`],
    },
    "seed-2-0-mini": {
        bestFor: msg`Efficient reasoning tasks requiring ByteDance's compact and fast model`,
        strengths: [msg`ByteDance's compact reasoning model`, msg`Vision support with efficient inference`, msg`Fast reasoning at low cost`],
        tags: [msg`reasoning`, msg`fast`, msg`compact`, msg`vision`],
    },
    "seed-1-6": {
        bestFor: msg`Vision reasoning tasks requiring ByteDance's capable Seed model`,
        strengths: [msg`ByteDance's capable vision reasoning model`, msg`Strong multimodal understanding`, msg`Good balance of reasoning and speed`],
        tags: [msg`reasoning`, msg`vision`, msg`balanced`],
    },
    "seed-1-8": {
        bestFor: msg`Demanding tasks requiring ByteDance's most advanced Seed reasoning model`,
        strengths: [
            msg`ByteDance's latest and most capable reasoning model`,
            msg`Advanced vision and reasoning integration`,
            msg`Frontier-level performance from Seed family`,
        ],
        tags: [msg`reasoning`, msg`vision`, msg`frontier`],
    },
    "seed-1-6-flash": {
        bestFor: msg`Fast vision reasoning requiring ByteDance's efficient flash model`,
        strengths: [
            msg`Ultra-fast multimodal deep thinking`,
            msg`ByteDance's fastest vision reasoning model`,
            msg`Efficient for high-throughput visual reasoning`,
        ],
        tags: [msg`fast`, msg`reasoning`, msg`vision`],
    },
    "trinity-large": {
        bestFor: msg`Frontier reasoning requiring Arcee's large open-weight MoE model`,
        strengths: [
            msg`400B parameter MoE with 13B active per token`,
            msg`Open-weight frontier reasoning model`,
            msg`Vision support with efficient sparse routing`,
        ],
        tags: [msg`frontier`, msg`reasoning`, msg`MoE`, msg`open source`],
    },
    "trinity-mini": {
        bestFor: msg`Compact reasoning tasks requiring Arcee's efficient small model`,
        strengths: [msg`Arcee's compact reasoning model`, msg`Efficient reasoning at small scale`, msg`Good quality-to-cost ratio for reasoning tasks`],
        tags: [msg`reasoning`, msg`compact`, msg`efficient`],
    },
    "mercury-2": {
        bestFor: msg`Ultra-fast inference tasks requiring Inception's novel diffusion-based architecture`,
        strengths: [msg`Novel diffusion-based language model architecture`, msg`Ultra-fast text generation speed`, msg`Unique approach to language modeling`],
        tags: [msg`fast`, msg`novel architecture`, msg`efficient`],
    },
    "step-3-5-flash": {
        bestFor: msg`Fast, efficient tasks requiring StepFun's optimized flash model`,
        strengths: [msg`StepFun's fast and efficient model`, msg`Quick inference for production use`, msg`Good quality at flash speed`],
        tags: [msg`fast`, msg`efficient`, msg`production`],
    },
    "kat-coder-pro-v1": {
        bestFor: msg`Professional coding tasks requiring Kwaipilot's advanced coding model`,
        strengths: [
            msg`Kwaipilot's advanced coding-focused model`,
            msg`Strong code generation and understanding`,
            msg`Specialized for professional development workflows`,
        ],
        tags: [msg`coding`, msg`professional`, msg`specialized`],
    },
};

const mergeWithSeo = (entries: ModelCatalogEntry[]): MarketingModel[] =>
    entries.flatMap((e) => (e.slug in SEO_EXTRAS ? [{ ...e, ...(SEO_EXTRAS[e.slug] as SeoExtras) }] : []));

export const IMAGE_MODELS: MarketingModel[] = mergeWithSeo(IMAGE_CATALOG);
export const VIDEO_MODELS: MarketingModel[] = mergeWithSeo(VIDEO_CATALOG);
export const TEXT_MODELS: MarketingModel[] = mergeWithSeo(TEXT_CATALOG);
export const ALL_MODELS: MarketingModel[] = [...IMAGE_MODELS, ...VIDEO_MODELS, ...TEXT_MODELS];

export const getModelBySlug = (slug: string): MarketingModel | undefined => ALL_MODELS.find((m) => m.slug === slug);
