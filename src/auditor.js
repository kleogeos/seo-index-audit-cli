'use strict';

const KNOWN_CRAWLERS = ['googlebot', 'bingbot', 'baiduspider', 'yandexbot'];

function normalizeBaseUrl(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed;
}

function parseRobotsTxt(text) {
  const lines = text.split(/\r?\n/);
  const groups = []; // { agents: [...], disallow: [...], allow: [...] }
  const sitemaps = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.disallow.length || current.allow.length) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'disallow') {
      if (!current) {
        current = { agents: ['*'], disallow: [], allow: [] };
        groups.push(current);
      }
      current.disallow.push(value);
    } else if (field === 'allow') {
      if (!current) {
        current = { agents: ['*'], disallow: [], allow: [] };
        groups.push(current);
      }
      current.allow.push(value);
    } else if (field === 'sitemap') {
      sitemaps.push(value);
    }
  }

  return { groups, sitemaps };
}

function evaluateRobots(parsed) {
  const issues = [];
  const notes = [];

  const blocksAll = (agentKey) =>
    parsed.groups.some(
      (g) => g.agents.includes(agentKey) && g.disallow.some((d) => d.trim() === '/')
    );

  if (blocksAll('*')) {
    issues.push(
      "robots.txt blocks ALL crawlers ('User-agent: *' + 'Disallow: /') - the whole site is opted out of indexing."
    );
  }

  for (const crawler of KNOWN_CRAWLERS) {
    if (!blocksAll('*') && blocksAll(crawler)) {
      issues.push(
        `robots.txt specifically blocks ${crawler} ('Disallow: /') while other crawlers are allowed - this crawler will not index the site.`
      );
    }
  }

  if (parsed.sitemaps.length === 0) {
    notes.push(
      'robots.txt has no Sitemap: directive - not an error, but adding one helps crawlers discover the sitemap faster.'
    );
  }

  return { issues, notes, declaredSitemaps: parsed.sitemaps };
}

function parseSitemapXml(text) {
  const looksLikeSitemap = /<urlset[\s>]/i.test(text) || /<sitemapindex[\s>]/i.test(text);
  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const locs = [...text.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map((m) => m[1]);
  const lastmodCount = (text.match(/<lastmod>/gi) || []).length;
  const startsWithXmlDecl = /^\s*<\?xml/i.test(text);

  return {
    looksLikeSitemap,
    isIndex,
    urlCount: locs.length,
    sampleUrls: locs.slice(0, 5),
    lastmodCount,
    startsWithXmlDecl,
  };
}

function evaluateSitemap(parsed, baseHost) {
  const issues = [];
  const notes = [];

  if (!parsed.looksLikeSitemap) {
    issues.push(
      "sitemap response doesn't contain <urlset> or <sitemapindex> - it may not be a valid sitemap (check it isn't an HTML error page served with a 200 status)."
    );
    return { issues, notes };
  }

  if (!parsed.startsWithXmlDecl) {
    notes.push(
      "sitemap doesn't start with an <?xml ...?> declaration - most parsers tolerate this, but it's not strictly valid XML."
    );
  }

  if (parsed.isIndex) {
    notes.push('this is a sitemap index (points to other sitemaps), not a direct URL list.');
  } else if (parsed.urlCount === 0) {
    issues.push('sitemap is a valid <urlset> but contains zero <loc> entries.');
  } else {
    const offHost = parsed.sampleUrls.filter((u) => {
      try {
        return new URL(u).host !== baseHost;
      } catch {
        return true;
      }
    });
    if (offHost.length > 0) {
      issues.push(
        `some sitemap URLs point to a different host than the site itself (e.g. ${offHost[0]}) - crawlers may ignore or distrust these entries.`
      );
    }
    if (parsed.lastmodCount === 0) {
      notes.push(
        'no <lastmod> dates found - not required, but they help crawlers prioritize re-crawling changed pages.'
      );
    }
  }

  return { issues, notes };
}

function evaluateHomepage(html, headers) {
  const issues = [];
  const notes = [];

  const metaRobotsMatch = html.match(
    /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i
  );
  const metaContent = metaRobotsMatch ? metaRobotsMatch[1].toLowerCase() : null;
  if (metaContent && metaContent.includes('noindex')) {
    issues.push(
      `homepage <meta name="robots"> contains "noindex" (content="${metaContent}") - this explicitly tells crawlers not to index the page, overriding robots.txt/sitemap.`
    );
  }

  const xRobotsHeader = headers && typeof headers.get === 'function' ? headers.get('x-robots-tag') : null;
  if (xRobotsHeader && xRobotsHeader.toLowerCase().includes('noindex')) {
    issues.push(
      `homepage response has an X-Robots-Tag header containing "noindex" (${xRobotsHeader}) - same effect as a noindex meta tag, often missed because it's not visible in page source.`
    );
  }

  const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  if (!hasCanonical) {
    notes.push('no <link rel="canonical"> tag found on the homepage - optional, but recommended to avoid duplicate-content ambiguity.');
  }

  return { issues, notes };
}

async function fetchText(fetchImpl, url) {
  const res = await fetchImpl(url);
  const text = typeof res.text === 'function' ? await res.text() : '';
  return { ok: res.ok, status: res.status, text, headers: res.headers };
}

async function auditSite({ url, fetchImpl = globalThis.fetch }) {
  if (!fetchImpl) {
    throw new Error('No fetch implementation available - pass fetchImpl explicitly.');
  }
  const base = normalizeBaseUrl(url);
  const hostRoot = new URL('/', base);
  const report = {
    site: base.href,
    robots: null,
    sitemap: null,
    homepage: null,
    issues: [],
    notes: [],
  };

  // 1. robots.txt - the exclusion protocol requires it to live at the host root,
  // not at whatever subpath the site itself is served from.
  const robotsUrl = new URL('/robots.txt', hostRoot).href;
  let robotsText = '';
  let robotsFetched = false;
  try {
    const robotsRes = await fetchText(fetchImpl, robotsUrl);
    robotsFetched = robotsRes.ok;
    robotsText = robotsRes.ok ? robotsRes.text : '';
    if (!robotsRes.ok) {
      report.notes.push(`robots.txt returned HTTP ${robotsRes.status} - crawlers will assume no restrictions (treated as "allow all"), which is usually fine.`);
    }
  } catch (err) {
    report.notes.push(`robots.txt could not be fetched (${err.message}) - crawlers will assume no restrictions.`);
  }

  let declaredSitemaps = [];
  if (robotsFetched) {
    const parsedRobots = parseRobotsTxt(robotsText);
    const evalRobots = evaluateRobots(parsedRobots);
    report.robots = { fetched: true, ...evalRobots };
    report.issues.push(...evalRobots.issues);
    report.notes.push(...evalRobots.notes);
    declaredSitemaps = evalRobots.declaredSitemaps;
  } else {
    report.robots = { fetched: false, issues: [], notes: [], declaredSitemaps: [] };
  }

  // 2. sitemap.xml (prefer robots.txt-declared sitemap, fallback to sitemap.xml
  // next to the given site path - many sites don't keep it at the host root)
  const sitemapUrl = declaredSitemaps[0] || new URL('sitemap.xml', base).href;
  try {
    const sitemapRes = await fetchText(fetchImpl, sitemapUrl);
    if (!sitemapRes.ok) {
      report.issues.push(`sitemap at ${sitemapUrl} returned HTTP ${sitemapRes.status} - crawlers cannot discover URLs through it.`);
      report.sitemap = { fetched: false, url: sitemapUrl };
    } else {
      const parsedSitemap = parseSitemapXml(sitemapRes.text);
      const evalSitemap = evaluateSitemap(parsedSitemap, base.host);
      report.sitemap = { fetched: true, url: sitemapUrl, ...parsedSitemap };
      report.issues.push(...evalSitemap.issues);
      report.notes.push(...evalSitemap.notes);
    }
  } catch (err) {
    report.issues.push(`sitemap at ${sitemapUrl} could not be fetched (${err.message}).`);
    report.sitemap = { fetched: false, url: sitemapUrl };
  }

  // 3. homepage meta robots / X-Robots-Tag
  try {
    const homeRes = await fetchImpl(base.href);
    const homeText = typeof homeRes.text === 'function' ? await homeRes.text() : '';
    const evalHome = evaluateHomepage(homeText, homeRes.headers);
    report.homepage = { fetched: homeRes.ok, status: homeRes.status };
    report.issues.push(...evalHome.issues);
    report.notes.push(...evalHome.notes);
  } catch (err) {
    report.notes.push(`homepage could not be fetched (${err.message}) - skipped meta robots check.`);
    report.homepage = { fetched: false };
  }

  return report;
}

module.exports = { auditSite, parseRobotsTxt, evaluateRobots, parseSitemapXml, evaluateSitemap, evaluateHomepage, normalizeBaseUrl };
