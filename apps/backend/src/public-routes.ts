/** Public, read-only site content. The dashboard and every other route stay private. */
export function isPublicStaticPath(path: string): boolean {
  return path === "/" || path === "/index.html"
    || path === "/waitlist" || path === "/waitlist/" || path === "/waitlist/index.html"
    || path === "/why-shiba" || path === "/why-shiba/" || path === "/why-shiba/index.html"
    || path === "/docs" || path === "/docs/" || path.startsWith("/docs/")
    || path.startsWith("/_astro/") || path.startsWith("/assets/") || path.startsWith("/pagefind/")
    || path === "/favicon.ico" || path === "/favicon.svg" || path === "/favicon-32x32.png"
    || path === "/robots.txt" || path === "/sitemap.xml" || path === "/sitemap-index.xml"
    || path === "/sitemap-0.xml" || path === "/llms.txt" || path === "/404.html";
}

export function isPublicRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return ((request.method === "GET" || request.method === "HEAD") && isPublicStaticPath(path))
    || (request.method === "POST" && path === "/api/waitlist");
}
