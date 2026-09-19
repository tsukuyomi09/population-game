import type { Metadata } from "next";
import type { ReactNode } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

export const metadata: Metadata = {
  title: "World Map",
  description: "An interactive world map",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, overflow: "hidden" }}>{children}</body>
    </html>
  );
}
