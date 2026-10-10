/**
 * Cinema Studio UI Types and Options
 * Re-exports shared types and constants from `@neore/ai` package
 */

// Re-export shared constants and option interfaces from AI package
export type { ApertureOption, CameraOption, FocalLengthOption, LensOption } from "@neore/ai/constants/cinema";
export { APERTURE_OPTIONS, CAMERA_OPTIONS, FOCAL_LENGTH_OPTIONS, LENS_OPTIONS } from "@neore/ai/constants/cinema";

// Re-export shared types from AI package
export type { Aperture, CameraType, CinemaSettings, FocalLength, LensType } from "@neore/ai/types/cinema";
