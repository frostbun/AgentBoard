import type { Metadata, Viewport } from "next";
import { ScrollHider } from "@/components/scroll-hider";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentBoard",
  description: "Control herdr agents from your phone",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "AgentBoard" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#08090b",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <ScrollHider />
        {children}
      </body>
    </html>
  );
}
