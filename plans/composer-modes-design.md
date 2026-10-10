# Composer Modes Design System

## Overview

The composer features a **minimal, Perplexity-inspired design** with subtle mode-specific variations for Text, Image, Video, and Audio modes. The aesthetic prioritizes clarity, professionalism, and restraint over bold visual statements.

## Mode-Specific Design Elements

### Visual Identity

Each mode uses **subtle, muted colors** inspired by Perplexity's minimal interface:

| Mode  | Light Mode       | Dark Mode        | Character              |
|-------|------------------|------------------|------------------------|
| Text  | Slate 600 (#475569)   | Slate 400 (#94A3B8)   | Neutral, professional  |
| Image | Gray 600 (#6B7280)    | Gray 400 (#9CA3AF)    | Balanced, understated  |
| Video | Zinc 600 (#52525B)    | Zinc 400 (#A1A1AA)    | Cool, modern           |
| Audio | Gray 700 (#374151)    | Gray 400 (#9CA3AF)    | Subtle, refined        |

**Minimal Design Philosophy:**
- Very low color saturation (gray scale with subtle tints)
- Minimal opacity gradients (3% vs original 5-8%)
- Subtle borders (15% light, 20% dark opacity)
- Soft shadows (sm instead of lg/complex)
- Clean white backgrounds in light mode
- Focus on content over decoration
- Perplexity-inspired restraint and elegance

### Key Features

1. **Mode Badge** (top-left)
   - Animated badge showing current mode
   - Mode icon + label with mode-specific accent color
   - Smooth transitions when switching modes

2. **Border & Glow**
   - Border color matches mode accent
   - Subtle glow effect using mode color
   - Enhanced on mode toggle hover

3. **Background Gradient**
   - Subtle gradient overlay using mode accent
   - Creates atmospheric depth without overwhelming content
   - Opacity-controlled for readability

4. **Enhanced Mode Selector**
   - Visual mode cards with icons and colors
   - Active mode highlighted with ring in accent color
   - Improved descriptions for clarity

## Component Architecture

### ComposerBase

The base component provides the visual framework:
- Mode toggle (when enabled)
- Mode-specific styling container
- Mode settings slot (for mode-specific controls)
- Input area slot
- Bottom toolbar slot

### Mode-Specific Settings

Each mode has dedicated settings:

- **Text Mode**: No inline settings, but shows search mode selector in toolbar
- **Image Mode**: Aspect ratio, quality, style
- **Video Mode**: Aspect ratio, duration with presets
- **Audio Mode**: Voice selection, playback speed

### Bottom Toolbar

**Always visible in all modes:**
- Model picker button
- Language selector

**Mode-specific:**
- Search mode selector (text mode only) - animated in/out

## Layout Rules

1. **Model & Language Selectors**: Present in ALL modes (text, image, video, audio)
2. **Search Mode (Tool Call)**: ONLY in text mode
3. **Mode Settings**: Inline controls above input for image/video/audio modes
4. **Suggestions**: Only shown in text mode (welcome suggestions, follow-up suggestions, prompt improvement)

## Animation Details

- Mode transitions use spring physics for organic feel
- Badge and mode toggle icon rotate on mode change
- Search mode selector fades in/out when switching to/from text mode
- Reduced motion respects user preferences

## Theme System

The composer automatically adapts to light and dark themes:

### Theme Detection
- Uses `MutationObserver` to watch for `dark` class changes on `<html>`
- Reactive color system that updates instantly on theme switch
- No page reload or flicker required

### Color Adaptation
- **Accent Colors**: Deeper (600) in light mode, brighter (500) in dark mode
- **Borders**: Higher contrast in light mode for better definition
- **Gradients**: More visible in light mode (8% vs 5% opacity)
- **Shadows**: Color-tinted shadows in light mode, standard shadows in dark
- **Backgrounds**: White/95 with backdrop blur in light, original in dark

### Contrast & Readability
- Light mode uses darker accent shades for WCAG AA compliance
- Badge backgrounds use theme-specific opacity levels
- Border opacity adjusted per theme for optimal visibility
- Gradient strength calibrated to not overwhelm content

## Design Philosophy

**Minimal Elegance** (Perplexity-Inspired)
- Restrained use of color - grayscale with subtle tints
- Mode distinction through subtle variations, not bold colors
- Smooth, minimal animations that don't distract
- Clean visual hierarchy through spacing and typography
- Professional appearance suitable for any context

**Consistency**
- Model and language selectors maintain position across modes
- Input area remains stable during mode transitions
- Predictable interaction patterns

## Implementation Notes

### Files Modified
- `composer-base.tsx` - Core visual framework with mode styling
- `composer.tsx` - Mode handling and toolbar composition
- `composer-audio-settings.tsx` - New audio settings component
- `model-store.ts` - Audio mode and settings support

### CSS Variables
Mode colors are hardcoded for precise control, but could be extracted to CSS variables if needed for theming.

### Accessibility
- Mode changes announced to screen readers
- Color is not the only indicator (icons + labels)
- Reduced motion support throughout
- Keyboard navigation maintained

## Future Enhancements

Potential improvements:
- Mode-specific placeholder text in input area
- More elaborate mode-specific animations
- Mode-specific input hints or overlays
- Saved presets per mode
