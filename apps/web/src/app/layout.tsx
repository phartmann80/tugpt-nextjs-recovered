import type { Metadata } from "next";
import "./globals.css";
import { APP_CONFIG } from "@/config/locales";

// Read from APP_CONFIG rather than repeating it. Both values lived in two
// places until 2026-08-28, and the copy here is what carried the dead domain
// into the browser tab.
export const metadata: Metadata = {
  title: APP_CONFIG.name,
  description: APP_CONFIG.description,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="min-h-screen flex flex-col antialiased">
        {children}
      </body>
    </html>
  );
}
