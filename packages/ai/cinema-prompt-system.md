# Cinema Prompt System - Photorealistic Image Generation

## Overview

The Cinema Prompt System simulates physical camera characteristics to generate photorealistic imagery. It transforms simple user prompts into sophisticated instructions that guide AI image generation models through the lens of professional cinematography.

## Architecture

```text
User Input (Simple)
    ↓
Cinema Settings (UI Controls)
    ↓
buildCinemaPrompt() Function
    ↓
Enhanced Prompt (Structured)
    ↓
Image Generation Model
    ↓
Photorealistic Output
```

## Core Components

### 1. Camera Logic (Image Character)

Each camera system has distinct characteristics:

**Digital Cameras:**

- **Red V-Raptor**: Clean 8K digital, punchy saturation, clinical sharpness
- **Sony Venice 2**: Neutral color science, blockbuster aesthetic
- **ARRI Alexa Mini LF**: Creamy highlights, perfect skin tones, prestige TV look
- **Blackmagic URSA 12K**: Sharp digital edge, documentary realism
- **Panavision DXL2**: Large format, polished Hollywood look

**Film Cameras:**

- **IMAX 70mm**: Fine organic grain, epic cinematic atmosphere
- **Arriflex 16SR**: Heavy chunky grain, vintage indie look

### 2. Lens Logic (Optical Character)

Each lens type creates unique optical effects:

**Spherical Lenses:**

- **Cooke S4i**: The Cooke Look, warm painterly skin tones, creamy bokeh
- **Zeiss Ultra Prime**: Clinical sharpness, zero distortion, ruthlessly detailed
- **Canon K-35**: Vintage 1970s glass, soft glowing highlights, dreamlike sharpness

**Anamorphic Lenses:**

- **Panavision C-Series**: 2x squeeze, distinctive oval bokeh, horizontal blue flares
- **Hawk V-Lite**: Modern anamorphic aesthetic, 1.3x squeeze

**Specialty Lenses:**

- **Lensbaby**: Sweet spot focus, heavy radial blur, dreamy tilt-shift effect
- **Petzval**: Distinctive swirly bokeh, 19th-century portrait aesthetic

### 3. Focal Length Logic (Psychology & Framing)

Each focal length creates a unique psychological perspective:

| Focal Length | Psychology                                | Use Case                      |
| ------------ | ----------------------------------------- | ----------------------------- |
| 8mm          | Extreme distortion, experimental framing  | Fisheye effects               |
| 14mm         | Expanded background, architectural        | Ultra-wide establishing shots |
| 24mm         | Environmental context, slight distortion  | Storytelling perspective      |
| 35mm         | Intimate perspective, immersive feel      | Street photography style      |
| 50mm         | Natural human eye perspective             | Unbiased observation          |
| 85mm         | Flattering facial proportions             | Portrait photography          |
| 100mm        | Tight framing, intense focus              | Macro details                 |
| 135mm        | Background compression, elegant distance  | Portrait isolation            |
| 200mm        | Extreme compression, voyeuristic distance | Abstract bokeh layers         |

### 4. Aperture Logic (Depth of Field Psychology)

Aperture controls depth of field and background blur:

| Aperture      | Depth of Field | Effect                                     |
| ------------- | -------------- | ------------------------------------------ |
| f/1.4         | Ultra-shallow  | Extreme bokeh, razor-thin focus plane      |
| f/2.0         | Shallow        | Beautiful background separation, cinematic |
| f/2.8         | Moderate       | Balanced focus, professional look          |
| f/4.0 - f/5.6 | Balanced       | More environmental context                 |
| f/8.0         | Deep           | Documentary style clarity                  |
| f/11          | Very deep      | Landscape photography depth                |
| f/16          | Maximum        | Pin-sharp throughout, no bokeh             |

## Prompt Structure

The `buildCinemaPrompt()` function creates structured prompts with these sections:

```text
1. Role Prefix (Visual Reasoning Engine instruction)
2. Scene Description (user's original prompt)
3. Visual Standards (photorealistic baseline)
4. Camera Characteristics (sensor, color science, grain)
5. Lens Characteristics (optical effects, bokeh, flares)
6. Focal Length Psychology (framing, perspective)
7. Aperture & Depth of Field (focus plane control)
8. Negative Guidance (what to avoid)
```

## Example Transformation

### Input:

```typescript
buildCinemaPrompt("a serene mountain landscape at golden hour", {
    aperture: 2.8,
    camera: "arri-alexa",
    enabled: true,
    focalLength: 35,
    lens: "cooke-s4",
});
```

### Output:

```text
You are the Visual Reasoning Engine. Your task is to output photorealistic
imagery by simulating a physical camera. Scene: a serene mountain landscape
at golden hour. photorealistic imagery, professional color grading, cinematic
lighting, physically accurate shadows, realistic material properties, proper
exposure. shot on ARRI Alexa Mini LF, Arri color science, creamy highlight
roll-off, perfect skin tones, organic digital look, teal and orange nuance,
soft natural contrast, cinematic prestige TV look. Cooke S4i Prime lens, The
Cooke Look, warm painterly skin tones, creamy bokeh, low micro-contrast,
gentle focus fall-off, flattering portrait rendering, smooth optical
characteristics. 35mm focal length, intimate perspective, street photography
style, immersive feel, slight facial distortion, distinct subject-environment
relationship. f/2.8 aperture, moderate depth of field, balanced focus,
professional look, smooth bokeh transition. Avoid: digital artifacts,
over-sharpening, HDR halos, unnatural saturation, fake bokeh effects,
unrealistic lighting, cartoonish rendering, artificial noise.
```

## UI Integration

### Cinema Studio Controls (UI Components)

The system provides refined UI components for selecting cinema parameters:

**CinemaVerticalPicker:**

- Scroll-based selection with snap-to-center
- Keyboard arrow navigation (↑↓)
- Visual navigation arrows at top/bottom
- Focus indicators and keyboard hints
- Refined aesthetics matching chat design

**Cinema Settings:**

1. **Camera Picker**: Horizontal scroll picker for camera selection
2. **Lens Picker**: Vertical picker for lens type
3. **Focal Length Picker**: Vertical picker for focal length
4. **Aperture Picker**: Vertical picker for aperture value

### Integration Points

**Frontend:**

- `app/src/features/chat/components/cinema-studio/` - UI components
- `app/src/features/chat/core/stores/model-store.ts` - State management
- Cinema settings stored per-thread in Zustand

**Backend:**

- `packages/ai/src/prompts/cinema.ts` - Prompt builder
- `packages/ai/src/types/cinema.ts` - Type definitions
- `packages/ai/src/constants/cinema.ts` - UI options

**Data Flow:**

```text
UI Cinema Controls
    ↓
Model Store (Zustand)
    ↓
HTTP Request (chat-context.tsx)
    ↓
Backend action (generateImage/generateVideo)
    ↓
buildCinemaPrompt()
    ↓
Enhanced Prompt → Image Generation API
```

## Visual Standards

The system enforces these quality baselines:

- ✅ Photorealistic imagery
- ✅ Professional color grading
- ✅ Cinematic lighting
- ✅ Physically accurate shadows
- ✅ Realistic material properties
- ✅ Proper exposure

## Negative Guidance

The system explicitly avoids:

- ❌ Digital artifacts
- ❌ Over-sharpening
- ❌ HDR halos
- ❌ Unnatural saturation
- ❌ Fake bokeh effects
- ❌ Unrealistic lighting
- ❌ Cartoonish rendering
- ❌ Artificial noise

## Best Practices

### Camera Selection

**Use ARRI Alexa Mini LF when:**

- Shooting portraits (perfect skin tones)
- Need organic digital look
- Want prestige TV aesthetic

**Use Red V-Raptor when:**

- Need maximum sharpness
- Want punchy commercial look
- Require clinical precision

**Use IMAX 70mm when:**

- Need epic scale
- Want fine organic grain
- Shooting grand landscapes

**Use Arriflex 16SR when:**

- Want vintage indie aesthetic
- Need nostalgic feel
- Want heavy grain character

### Lens Selection

**Use Cooke S4i when:**

- Shooting portraits (warm skin tones)
- Want creamy bokeh
- Need flattering rendering

**Use Panavision C-Series Anamorphic when:**

- Want cinematic widescreen look
- Need horizontal blue flares
- Want distinctive oval bokeh

**Use Zeiss Ultra Prime when:**

- Need clinical sharpness
- Want zero distortion
- Require 3D pop effect

### Focal Length Selection

**Use 35mm when:**

- Need intimate perspective
- Want immersive street photography feel
- Balanced subject-environment relationship

**Use 85mm when:**

- Shooting portraits (flattering proportions)
- Need subject isolation
- Want creamy background bokeh

**Use 24mm when:**

- Need environmental context
- Want storytelling perspective
- Establishing shots

### Aperture Selection

**Use f/1.4 - f/2.0 when:**

- Want extreme bokeh
- Need subject isolation
- Creating dreamy atmosphere

**Use f/2.8 - f/5.6 when:**

- Want balanced depth
- Need professional look
- Moderate background blur

**Use f/8.0 - f/16 when:**

- Want everything in focus
- Shooting landscapes
- Need documentary clarity

## Advanced Usage

### Combining Settings for Specific Looks

**Cinematic Portrait:**

- Camera: ARRI Alexa Mini LF
- Lens: Cooke S4i
- Focal Length: 85mm
- Aperture: f/2.0

**Epic Landscape:**

- Camera: IMAX 70mm
- Lens: Zeiss Ultra Prime
- Focal Length: 24mm
- Aperture: f/11

**Vintage Indie:**

- Camera: Arriflex 16SR
- Lens: Canon K-35
- Focal Length: 35mm
- Aperture: f/2.8

**Blockbuster Action:**

- Camera: Sony Venice 2
- Lens: Panavision C-Series Anamorphic
- Focal Length: 35mm
- Aperture: f/2.8

**Documentary Realism:**

- Camera: Blackmagic URSA 12K
- Lens: Zeiss Ultra Prime
- Focal Length: 50mm
- Aperture: f/8.0

## Future Enhancements

Potential additions to the cinema system:

1. **Film Stocks**: Add specific film stock characteristics (Kodak Vision3, Fuji Velvia)
2. **Lighting Setups**: Pre-defined lighting scenarios (Rembrandt, Loop, Butterfly)
3. **Color Grades**: Preset color grading styles (Bleach Bypass, Teal & Orange, Vintage)
4. **Motion Blur**: Shutter angle/speed settings for movement rendering
5. **Lens Effects**: Additional effects (lens breathing, chromatic aberration, vignetting)
6. **Sensor Characteristics**: ISO performance, noise patterns, dynamic range curves
7. **Presets**: Save/load favorite cinema configurations
8. **Auto-Detection**: Suggest cinema settings based on prompt analysis

## Performance Notes

- Cinema prompt enhancement adds ~200-500 tokens to prompts
- Slight increase in generation time (~5-10%) due to longer prompts
- Significantly better quality and consistency in generated images
- Works with all image generation models (Flux, SDXL, Google Imagen)
- Can be disabled per-generation by setting `cinema.enabled = false`

## Credits

Inspired by professional cinematography and cinema camera systems from:

- ARRI (Alexa series)
- Red Digital Cinema (V-Raptor, Epic)
- Panavision (DXL2, C-Series Anamorphic)
- Sony (Venice 2)
- Blackmagic Design (URSA)
- Cooke Optics (S4i)
- Zeiss (Ultra Prime)
- Canon (K-35 Vintage)

## References

- [ARRI Alexa Mini LF Specs](https://www.arri.com/en/camera-systems/cameras/alexa-mini-lf)
- [Red V-Raptor Specs](https://www.red.com/v-raptor)
- [Cooke S4/i Lenses](https://cookeoptics.com/lenses/s4-i/)
- [Cinema5D Camera Reviews](https://www.cinema5d.com/)
- [ASC Manual (Cinematography)](https://theasc.com/asc/manual/)
