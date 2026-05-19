import type { OverlayFontId } from "@/lib/fonts";

export type OverlayKind = "text" | "sticker";

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
  // text and sticker — sticker is a single glyph rendered like emoji.
  fontSize: number;
  // Box width as a fraction of composition width (0..1). Text wraps within
  // this width — shrink for stacked words, expand for single-line.
  widthFraction: number;
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
// Stickers are image-based (Twemoji SVGs) so default larger — closer to the
// WhatsApp sticker scale than emoji-as-text.
export const DEFAULT_STICKER_FONT_SIZE = 240;
export const DEFAULT_TEXT_COLOR = "#ffffff";
export const DEFAULT_TEXT_WIDTH_FRACTION = 0.7;
export const DEFAULT_STICKER_WIDTH_FRACTION = 0.32;
export const MIN_WIDTH_FRACTION = 0.08;
export const MAX_WIDTH_FRACTION = 1;

// Twemoji SVG asset URL for a unicode emoji glyph. Twemoji strips the U+FE0F
// variation selector. Pinned to v14.0.2 (last stable before the Twitter→jdecked
// fork) for URL stability.
const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg";
export function twemojiUrlFor(glyph: string): string {
  const codepoints = Array.from(glyph)
    .map((c) => c.codePointAt(0))
    .filter((c): c is number => c != null && c !== 0xfe0f)
    .map((c) => c.toString(16))
    .join("-");
  return `${TWEMOJI_BASE}/${codepoints}.svg`;
}

// Unicode glyphs used by both (a) the inline emoji picker for text overlays
// and (b) the standalone sticker palette. Same source — when real SVG
// stickers ship, the sticker palette can diverge.
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

export const STICKER_PALETTE = EMOJI_PALETTE;

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
    widthFraction: DEFAULT_TEXT_WIDTH_FRACTION,
    color: DEFAULT_TEXT_COLOR,
    fontFamily: "inter",
    animation: "fade",
  };
}

export function createStickerOverlay(
  glyph: string,
  startSeconds: number,
): Overlay {
  return {
    id: crypto.randomUUID(),
    kind: "sticker",
    content: glyph,
    startSeconds: Math.max(0, startSeconds),
    durationSeconds: DEFAULT_OVERLAY_DURATION_SECONDS,
    x: 0.5,
    y: 0.5,
    fontSize: DEFAULT_STICKER_FONT_SIZE,
    widthFraction: DEFAULT_STICKER_WIDTH_FRACTION,
    animation: "fade",
  };
}

// Migration helper for overlays saved before the "emoji" → "sticker" rename.
// Old documents stored `kind: "emoji"`; map those to `"sticker"` on load.
export function migrateLoadedOverlay(o: unknown): Overlay {
  const v = o as Overlay & { kind: OverlayKind | "emoji" };
  if (v.kind === ("emoji" as OverlayKind | "emoji")) {
    return { ...v, kind: "sticker" };
  }
  return v as Overlay;
}
