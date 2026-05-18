import {
  Anton,
  Bebas_Neue,
  Caveat,
  Inter,
  Montserrat,
  Pacifico,
  Permanent_Marker,
  Playfair_Display,
} from "next/font/google";

const inter = Inter({ subsets: ["latin"], variable: "--font-overlay-inter" });
const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-overlay-montserrat",
  weight: ["400", "600", "800"],
});
const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-overlay-playfair",
});
const bebas = Bebas_Neue({
  subsets: ["latin"],
  variable: "--font-overlay-bebas",
  weight: "400",
});
const anton = Anton({
  subsets: ["latin"],
  variable: "--font-overlay-anton",
  weight: "400",
});
const pacifico = Pacifico({
  subsets: ["latin"],
  variable: "--font-overlay-pacifico",
  weight: "400",
});
const caveat = Caveat({
  subsets: ["latin"],
  variable: "--font-overlay-caveat",
});
const marker = Permanent_Marker({
  subsets: ["latin"],
  variable: "--font-overlay-marker",
  weight: "400",
});

export const OVERLAY_FONT_VARIABLES = [
  inter.variable,
  montserrat.variable,
  playfair.variable,
  bebas.variable,
  anton.variable,
  pacifico.variable,
  caveat.variable,
  marker.variable,
].join(" ");

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
