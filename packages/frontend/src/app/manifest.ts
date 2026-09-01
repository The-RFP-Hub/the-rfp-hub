import type { MetadataRoute } from "next";

/**
 * The web app manifest, served at `/manifest.webmanifest` and linked automatically.
 *
 * ICONS COME IN TWO SHAPES for two consumers. `icon.svg` and the rounded PNGs are the tile as it is
 * drawn — rounded corners, transparent outside — which is what a browser tab and an "any"-purpose
 * slot want. The `maskable` PNGs are full-bleed squares: Android and iOS crop an icon to their own
 * shape, so those keep the olive reaching every edge with the mark inside the safe zone, and never
 * show a clipped corner. Apple's touch icon (`app/apple-icon.png`) is the same full-bleed square.
 *
 * `theme_color` is PAPER, not olive. It tints the browser and standalone chrome to match the app's
 * actual near-white surface — the olive belongs to the icon, and letting it colour the whole window
 * would be exactly the accent-becomes-the-brand move the rest of the UI is disciplined against.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RFP Hub",
    short_name: "RFP Hub",
    description: "An open index of funding opportunities under one standard.",
    start_url: "/",
    display: "standalone",
    background_color: "#fcfcfa",
    theme_color: "#fcfcfa",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
      { src: "/icon-192-maskable.png", type: "image/png", sizes: "192x192", purpose: "maskable" },
      { src: "/icon-512-maskable.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
}
