'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  auditSite,
  parseRobotsTxt,
  evaluateRobots,
  parseSitemapXml,
  evaluateSitemap,
  evaluateHomepage,
  normalizeBaseUrl,
} = require('../src/auditor');

// ---- normalizeBaseUrl ----

test('normalizeBaseUrl adds https:// when missing and keeps a subpath (with trailing slash)', () => {
  const url = normalizeBaseUrl('example.com/some/page?x=1');
  assert.equal(url.href, 'https://example.com/some/page/');
});

test('normalizeBaseUrl keeps a bare host at root', () => {
  const url = normalizeBaseUrl('example.com');
  assert.equal(url.href, 'https://example.com/');
});

test('normalizeBaseUrl keeps explicit http://', () => {
  const url = normalizeBaseUrl('http://example.com');
  assert.equal(url.protocol, 'http:');
});

// ---- parseRobotsTxt ----

test('parseRobotsTxt groups consecutive user-agents and captures directives', () => {
  const text = [
    'User-agent: *',
    'Disallow: /admin',
    '',
    'User-agent: Baiduspider',
    'Disallow: /',
    '',
    'Sitemap: https://example.com/sitemap.xml',
  ].join('\n');
  const parsed = parseRobotsTxt(text);
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].agents, ['*']);
  assert.deepEqual(parsed.groups[0].disallow, ['/admin']);
  assert.deepEqual(parsed.groups[1].agents, ['baiduspider']);
  assert.deepEqual(parsed.sitemaps, ['https://example.com/sitemap.xml']);
});

test('parseRobotsTxt ignores comments and blank lines', () => {
  const text = '# comment\n\nUser-agent: *\n# another comment\nDisallow:\n';
  const parsed = parseRobotsTxt(text);
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].disallow, ['']);
});

// ---- evaluateRobots ----

test('evaluateRobots flags "Disallow: /" under User-agent: * as blocking everything', () => {
  const parsed = parseRobotsTxt('User-agent: *\nDisallow: /\n');
  const result = evaluateRobots(parsed);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /blocks ALL crawlers/);
});

test('evaluateRobots flags a specific crawler blocked while others are allowed', () => {
  const parsed = parseRobotsTxt('User-agent: *\nDisallow:\n\nUser-agent: Baiduspider\nDisallow: /\n');
  const result = evaluateRobots(parsed);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /specifically blocks baiduspider/);
});

test('evaluateRobots does not double-flag a specific crawler when "*" already blocks all', () => {
  const parsed = parseRobotsTxt('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /\n');
  const result = evaluateRobots(parsed);
  assert.equal(result.issues.length, 1);
});

test('evaluateRobots notes missing Sitemap directive', () => {
  const parsed = parseRobotsTxt('User-agent: *\nDisallow:\n');
  const result = evaluateRobots(parsed);
  assert.equal(result.issues.length, 0);
  assert.match(result.notes[0], /no Sitemap:/);
});

test('evaluateRobots is clean when site is fully open and declares a sitemap', () => {
  const parsed = parseRobotsTxt('User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n');
  const result = evaluateRobots(parsed);
  assert.equal(result.issues.length, 0);
  assert.equal(result.notes.length, 0);
});

// ---- parseSitemapXml ----

test('parseSitemapXml extracts loc entries from a valid urlset', () => {
  const xml =
    '<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://example.com/b</loc></url></urlset>';
  const parsed = parseSitemapXml(xml);
  assert.equal(parsed.looksLikeSitemap, true);
  assert.equal(parsed.isIndex, false);
  assert.equal(parsed.urlCount, 2);
  assert.equal(parsed.lastmodCount, 1);
  assert.equal(parsed.startsWithXmlDecl, true);
});

test('parseSitemapXml recognizes a sitemap index', () => {
  const xml = '<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>';
  const parsed = parseSitemapXml(xml);
  assert.equal(parsed.isIndex, true);
  assert.equal(parsed.looksLikeSitemap, true);
});

test('parseSitemapXml flags content that is not a sitemap at all', () => {
  const html = '<html><body>404 not found</body></html>';
  const parsed = parseSitemapXml(html);
  assert.equal(parsed.looksLikeSitemap, false);
});

// ---- evaluateSitemap ----

test('evaluateSitemap issues error when response is not a valid sitemap', () => {
  const parsed = parseSitemapXml('<html>oops</html>');
  const result = evaluateSitemap(parsed, 'example.com');
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /not be a valid sitemap/);
});

test('evaluateSitemap flags off-host URLs', () => {
  const xml = '<urlset><url><loc>https://other-domain.com/a</loc></url></urlset>';
  const parsed = parseSitemapXml(xml);
  const result = evaluateSitemap(parsed, 'example.com');
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /different host/);
});

test('evaluateSitemap flags zero URL entries in a valid urlset', () => {
  const xml = '<urlset></urlset>';
  const parsed = parseSitemapXml(xml);
  const result = evaluateSitemap(parsed, 'example.com');
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /zero <loc> entries/);
});

test('evaluateSitemap notes missing lastmod but does not treat it as a blocking issue', () => {
  const xml = '<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url></urlset>';
  const parsed = parseSitemapXml(xml);
  const result = evaluateSitemap(parsed, 'example.com');
  assert.equal(result.issues.length, 0);
  assert.match(result.notes[0], /no <lastmod>/);
});

// ---- evaluateHomepage ----

test('evaluateHomepage flags noindex meta robots tag', () => {
  const html = '<html><head><meta name="robots" content="noindex, nofollow"></head></html>';
  const result = evaluateHomepage(html, { get: () => null });
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /noindex/);
});

test('evaluateHomepage flags X-Robots-Tag noindex header even without meta tag', () => {
  const html = '<html><head></head></html>';
  const headers = { get: (name) => (name === 'x-robots-tag' ? 'noindex' : null) };
  const result = evaluateHomepage(html, headers);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /X-Robots-Tag/);
});

test('evaluateHomepage notes missing canonical link', () => {
  const html = '<html><head><meta name="robots" content="index, follow"></head></html>';
  const result = evaluateHomepage(html, { get: () => null });
  assert.equal(result.issues.length, 0);
  assert.match(result.notes[0], /canonical/);
});

// ---- auditSite (integration, mocked fetch) ----

function makeResponse({ ok = true, status = 200, text = '', headers = {} } = {}) {
  return {
    ok,
    status,
    text: async () => text,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
  };
}

test('auditSite runs end-to-end against a clean, well-configured site', async () => {
  const sitemapXml =
    '<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url></urlset>';
  const robotsTxt = 'User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n';
  const homeHtml = '<html><head><link rel="canonical" href="https://example.com/"></head></html>';

  const fetchImpl = async (url) => {
    if (url.endsWith('/robots.txt')) return makeResponse({ text: robotsTxt });
    if (url.includes('sitemap.xml')) return makeResponse({ text: sitemapXml });
    return makeResponse({ text: homeHtml });
  };

  const report = await auditSite({ url: 'example.com', fetchImpl });
  assert.equal(report.issues.length, 0);
  assert.equal(report.sitemap.urlCount, 1);
});

test('auditSite surfaces a blocking robots.txt issue end-to-end', async () => {
  const robotsTxt = 'User-agent: *\nDisallow: /\n';
  const fetchImpl = async (url) => {
    if (url.endsWith('/robots.txt')) return makeResponse({ text: robotsTxt });
    if (url.includes('sitemap.xml')) return makeResponse({ ok: false, status: 404 });
    return makeResponse({ text: '<html></html>' });
  };

  const report = await auditSite({ url: 'example.com', fetchImpl });
  assert.ok(report.issues.some((i) => /blocks ALL crawlers/.test(i)));
  assert.ok(report.issues.some((i) => /returned HTTP 404/.test(i)));
});

test('auditSite degrades gracefully when robots.txt fetch throws', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/robots.txt')) throw new Error('network down');
    if (url.includes('sitemap.xml')) return makeResponse({ ok: false, status: 404 });
    return makeResponse({ text: '<html></html>' });
  };

  const report = await auditSite({ url: 'example.com', fetchImpl });
  assert.equal(report.robots.fetched, false);
  assert.ok(report.notes.some((n) => /network down/.test(n)));
});

test('auditSite fetches robots.txt from the host root and sitemap.xml next to the given subpath', async () => {
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    if (url === 'https://kleogeos.github.io/robots.txt') return makeResponse({ ok: false, status: 404 });
    if (url === 'https://kleogeos.github.io/freelancer-tools/sitemap.xml') {
      return makeResponse({ text: '<urlset><url><loc>https://kleogeos.github.io/freelancer-tools/</loc></url></urlset>' });
    }
    return makeResponse({ text: '<html></html>' });
  };

  const report = await auditSite({ url: 'kleogeos.github.io/freelancer-tools', fetchImpl });
  assert.ok(seenUrls.includes('https://kleogeos.github.io/robots.txt'));
  assert.equal(report.sitemap.url, 'https://kleogeos.github.io/freelancer-tools/sitemap.xml');
  assert.equal(report.sitemap.urlCount, 1);
});

test('auditSite prefers the sitemap URL declared in robots.txt over the default path', async () => {
  const robotsTxt = 'User-agent: *\nDisallow:\nSitemap: https://example.com/custom-sitemap.xml\n';
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    if (url.endsWith('/robots.txt')) return makeResponse({ text: robotsTxt });
    if (url.includes('custom-sitemap.xml')) return makeResponse({ text: '<urlset><url><loc>https://example.com/</loc></url></urlset>' });
    return makeResponse({ text: '<html></html>' });
  };

  const report = await auditSite({ url: 'example.com', fetchImpl });
  assert.equal(report.sitemap.url, 'https://example.com/custom-sitemap.xml');
  assert.ok(!seenUrls.includes('https://example.com/sitemap.xml'));
});
