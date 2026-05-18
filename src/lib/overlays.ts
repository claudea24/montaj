import type { OverlayFontId } from "@/lib/fonts";

export type OverlayKind = "text" | "emoji";

export type OverlayAnimation = "none" | "fade" | "slide-up" | "zoom";

export type Overlay = {
  id: string;
  kind: OverlayKind;
  content: string;
  // Time in seconds within the composition timeline (not beats — overlays
  // don't need to snap to the music grid).
  startSeconds: number;
  durationSeconds: number;
  // Position as a fraction of composition size (0..1). 0.5 = center.
  x: number;
  y: number;
  // Font size in composition px (composition is 1080×1920). Used for both
  // text and emoji — emoji is just rendered as a single glyph.
  fontSize: number;
  // Hex color, text overlays only. Defaults to white.
  color?: string;
  // Google Font ID, text overlays only. Defaults to "inter".
  fontFamily?: OverlayFontId;
  // In/out animation. Default "fade" so newly added overlays don't pop.
  animation?: OverlayAnimation;
};

export const OVERLAY_ANIMATIONS: { id: OverlayAnimation; label: string }[] = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade in / out" },
  { id: "slide-up", label: "Slide up / out" },
  { id: "zoom", label: "Zoom in / out" },
];

export const DEFAULT_OVERLAY_DURATION_SECONDS = 2;
export const DEFAULT_TEXT_FONT_SIZE = 96;
export const DEFAULT_EMOJI_FONT_SIZE = 160;
export const DEFAULT_TEXT_COLOR = "#ffffff";

export const EMOJI_PALETTE = [
  "❤️",
  "🔥",
  "✨",
  "⭐",
  "🎉",
  "👍",
  "😂",
  "😍",
  "🥳",
  "💯",
  "🙌",
  "🎵",
  "🌟",
  "💖",
  "👀",
  "🤩",
];

export function createTextOverlay(
  content: string,
  startSeconds: number,
): Overlay {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    content,
    startSeconds: Math.max(0, startSeconds),
    durationSeconds: DEFAULT_OVERLAY_DURATION_SECONDS,
    x: 0.5,
    y: 0.5,
    fontSize: DEFAULT_TEXT_FONT_SIZE,
    color: DEFAULT_TEXT_COLOR,
    fontFamily: "inter",
    animation: "fade",
  };
}

export function createEmojiOverlay(
  emoji: string,
  startSeconds: number,
): Overlay {
  return {
    id: crypto.randomUUID(),
    kind: "emoji",
    content: emoji,
    startSeconds: Math.max(0, startSeconds),
    durationSeconds: DEFAULT_OVERLAY_DURATION_SECONDS,
    x: 0.5,
    y: 0.5,
    fontSize: DEFAULT_EMOJI_FONT_SIZE,
    animation: "fade",
  };
}
