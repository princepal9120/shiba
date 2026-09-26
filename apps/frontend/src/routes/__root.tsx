/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { name: "theme-color", content: "#0000a8" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Shiba" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "description", content: "Review, approve, and observe your self-hosted AI software engineer's coding tasks on your own Cloudflare account." },
      { property: "og:title", content: "Shiba Dashboard" },
      {
        property: "og:description",
        content: "Review, approve, and observe your self-hosted AI software engineer's coding tasks on your own Cloudflare account.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "/assets/mascot/pet-logo.png" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:image", content: "/assets/mascot/pet-logo.png" },
      { title: "Shiba Dashboard · Self-Hosted AI Software Engineer" },
    ],
    links: [
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/app/apple-touch-icon.png" },
      // use-credentials keeps the Access cookie on the manifest fetch.
      {
        rel: "manifest",
        href: "/app/manifest.webmanifest",
        crossOrigin: "use-credentials",
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    // next-themes, and browser extensions, rewrite <html> before React hydrates.
    <html lang="en" className="light" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-[#f6f4ed] text-[#222320] antialiased selection:bg-[#0000a8] selection:text-white">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
