import type { Metadata, Viewport } from "next";
import "./globals.css";
import { MOOD_BOOT } from "@/lib/mood";

export const metadata: Metadata = {
  title: "wdash",
  description: "Remote control for Claude agent teams",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, title: "wdash", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0f13" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-mood is set by the boot script before hydration, so React shouldn't complain about it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOOD_BOOT }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
