import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { OVERLAY_FONT_VARIABLES } from "@/lib/next-fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Montaj",
  description: "Week 1 reel-maker prototype",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={OVERLAY_FONT_VARIABLES} suppressHydrationWarning>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
