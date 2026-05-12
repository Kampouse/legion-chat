// Cloudflare Pages Function — SSR shell for public routes
// Reads the built index.html from assets, injects meta tags for SEO/social sharing

interface Env {}

function injectMeta(html: string, opts: {
  title: string;
  description: string;
  image?: string;
  url: string;
}): string {
  // Replace title
  let out = html.replace(
    /<title>.*?<\/title>/,
    `<title>${opts.title}</title>`,
  );

  // Inject meta tags before </head>
  const metaTags = `
    <meta name="description" content="${opts.description}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${opts.title}" />
    <meta property="og:description" content="${opts.description}" />
    <meta property="og:url" content="${opts.url}" />
    <meta property="og:site_name" content="Legion Chat" />
    <meta property="og:image" content="${opts.image || 'https://legion-chat.pages.dev/icons.svg'}" />
    <meta name="twitter:card" content="${opts.image ? 'summary_large_image' : 'summary'}" />
    <meta name="twitter:title" content="${opts.title}" />
    <meta name="twitter:description" content="${opts.description}" />
    ${opts.image ? `<meta name="twitter:image" content="${opts.image}" />` : ''}
  `;

  out = out.replace("</head>", `${metaTags}</head>`);
  return out;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Static assets — pass through to KV
  if (path.startsWith("/assets/") || path.startsWith("/src/") || path.includes(".")) {
    return context.env.ASSETS.fetch(request);
  }

  // Fetch the built index.html from assets
  const indexUrl = new URL("/index.html", url.origin).href;
  const indexResp = await context.env.ASSETS.fetch(new Request(indexUrl));
  let html = await indexResp.text();

  // Profile route — SSR with meta tags
  const profileMatch = path.match(/^\/p\/(npub1[a-z0-9]+)$/);
  if (profileMatch) {
    html = injectMeta(html, {
      title: "Profile — Legion Chat",
      description: "View this profile on Legion Chat — Nostr-powered group chat",
      url: url.href,
    });
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Feed / home — generic SSR shell
  if (path === "/" || path === "") {
    html = injectMeta(html, {
      title: "Legion Chat — Nostr Feed",
      description: "Public Nostr feed powered by Legion Chat. NEAR SBT-gated group chat with Nostr integration.",
      url: url.href,
    });
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" } ,
    });
  }

  // /chat or any other path — return index.html as-is for SPA routing
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};
