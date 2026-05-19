// next/font/google loaders. Used only by the Next.js app shell so the CSS
// variables (--font-overlay-inter, etc.) are registered globally. The
// composition itself reads those variables by name via OVERLAY_FONTS in
// `fonts.ts`, which is import-safe inside the Remotion bundle (no
// next/font dependency).
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
