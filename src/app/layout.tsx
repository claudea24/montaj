import type { Metadata } from "next";
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
