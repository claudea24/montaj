// Font lookup table for overlay text rendering. Contains no next/font imports
// so it's safe to use from inside the Remotion bundle (where Next.js's font
// loader does not exist). The CSS variables it references are registered by
// `next-fonts.ts` in the Next.js shell — when running outside that shell
// (e.g., headless Chrome during render) fonts fall back to the system stack
// listed in each cssFamily.

// CSS family strings include sensible fallbacks so unloaded fonts don't render
// invisibly. The `id` is what we store on the overlay; `cssFamily` is what we
// hand to React's style.fontFamily.
export const OVERLAY_FONTS = [
  {
    id: "inter",
    name: "Inter",
    cssFamily: "var(--font-overlay-inter), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "montserrat",
    name: "Montserrat",
    cssFamily:
      "var(--font-overlay-montserrat), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "playfair",
    name: "Playfair Display",
    cssFamily: "var(--font-overlay-playfair), Georgia, serif",
  },
  {
    id: "bebas",
    name: "Bebas Neue",
    cssFamily:
      "var(--font-overlay-bebas), Impact, ui-sans-serif, sans-serif",
  },
  {
    id: "anton",
    name: "Anton",
    cssFamily:
      "var(--font-overlay-anton), Impact, ui-sans-serif, sans-serif",
  },
  {
    id: "pacifico",
    name: "Pacifico",
    cssFamily: "var(--font-overlay-pacifico), cursive",
  },
  {
    id: "caveat",
    name: "Caveat",
    cssFamily: "var(--font-overlay-caveat), cursive",
  },
  {
    id: "marker",
    name: "Permanent Marker",
    cssFamily: "var(--font-overlay-marker), Impact, sans-serif",
  },
] as const;

export type OverlayFontId = (typeof OVERLAY_FONTS)[number]["id"];

export function fontFamilyFor(id: OverlayFontId | undefined): string {
  return (
    OVERLAY_FONTS.find((f) => f.id === id)?.cssFamily ??
    OVERLAY_FONTS[0].cssFamily
  );
}
