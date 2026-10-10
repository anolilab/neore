import type { NodeTypes } from "@xyflow/react";

import AdvancedControlsNode from "./advanced-controls-node";
import AINode from "./ai-node";
import AudioNode from "./audio-node";
import BackgroundRemovalNode from "./background-removal-node";
import BranchNode from "./branch-node";
import CharacterRefNode from "./character-ref-node";
import CodeNode from "./code-node";
import CommentNode from "./comment-node";
import ControlNetNode from "./controlnet-node";
import FileNode from "./file-node";
import GroupNode from "./group-node";
import ImageNode from "./image-node";
import ImageToVideoNode from "./image-to-video-node";
import Img2ImgNode from "./img2img-node";
import InpaintNode from "./inpaint-node";
import ObjectEditorNode from "./object-editor-node";
import OutpaintNode from "./outpaint-node";
import OutputNode from "./output-node";
import ParallelCompareNode from "./parallel-compare-node";
import StyleRefNode from "./style-ref-node";
import TextNode from "./text-node";
import TranscriptionNode from "./transcription-node";
import UpscaleNode from "./upscale-node";
import VideoNode from "./video-node";

export const nodeTypes: NodeTypes = {
    "advanced-controls": AdvancedControlsNode,
    ai: AINode,
    audio: AudioNode,
    "background-removal": BackgroundRemovalNode,
    branch: BranchNode,
    "character-ref": CharacterRefNode,
    code: CodeNode,
    comment: CommentNode,
    controlnet: ControlNetNode,
    file: FileNode,
    group: GroupNode,
    image: ImageNode,
    "image-to-video": ImageToVideoNode,
    img2img: Img2ImgNode,
    inpaint: InpaintNode,
    "object-editor": ObjectEditorNode,
    outpaint: OutpaintNode,
    output: OutputNode,
    "parallel-compare": ParallelCompareNode,
    "style-ref": StyleRefNode,
    text: TextNode,
    transcription: TranscriptionNode,
    upscale: UpscaleNode,
    video: VideoNode,
};

export { default as AdvancedControlsNode } from "./advanced-controls-node";
export { default as AINode } from "./ai-node";
export { default as AudioNode } from "./audio-node";
export { default as BackgroundRemovalNode } from "./background-removal-node";
export { default as BaseNode } from "./base-node";
export { default as BranchNode } from "./branch-node";
export { default as CharacterRefNode } from "./character-ref-node";
export { default as CodeNode } from "./code-node";
export { default as CommentNode } from "./comment-node";
export { default as ControlNetNode } from "./controlnet-node";
export { default as FileNode } from "./file-node";
export { default as GroupNode } from "./group-node";
export { default as ImageNode } from "./image-node";
export { default as ImageToVideoNode } from "./image-to-video-node";
export { default as Img2ImgNode } from "./img2img-node";
export { default as InpaintNode } from "./inpaint-node";
export { default as ObjectEditorNode } from "./object-editor-node";
export { default as OutpaintNode } from "./outpaint-node";
export { default as OutputNode } from "./output-node";
export { default as ParallelCompareNode } from "./parallel-compare-node";
export { default as StyleRefNode } from "./style-ref-node";
export { default as TextNode } from "./text-node";
export { default as TranscriptionNode } from "./transcription-node";
export { default as UpscaleNode } from "./upscale-node";
export { default as VideoNode } from "./video-node";
