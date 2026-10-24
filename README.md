# seo-index-audit-cli

Zero-dependency Node.js CLI that audits a site's `robots.txt`, `sitemap.xml`
and homepage `<meta name="robots">`/`X-Robots-Tag` for the issues that
actually block search engines (Google, Baidu, Bing, Yandex) from crawling
and indexing a site - instead of eyeballing the files by hand.

Built while doing a real technical SEO/indexing audit (robots.txt + sitemap
review for Baidu crawlability) - the kind of job where you need a fast,
repeatable check instead of reading raw robots.txt syntax under time
pressure.

## Install

```bash
git clone https://github.com/kleogeos/seo-index-audit-cli.git
cd seo-index-audit-cli
npm install
```

No runtime dependencies - `npm install` only pulls dev tooling (none, in
fact; `node --test` is built into Node 18+, and this uses the global `fetch`
also built into Node 18+).

## Usage

```bash
node bin/cli.js example.com
node bin/cli.js example.com/some-subpath      # for sites served from a subpath (e.g. GitHub Pages project sites)
node bin/cli.js example.com --json            # machine-readable output
```

Exit code is `2` if any blocking issue was found, so it can be dropped into
a CI/deployment check.

### Example

```
SEO index audit: https://example.com/

robots.txt: found
sitemap: found (45 URLs)
homepage: reachable (HTTP 200)

1 issue(s) found:
  ! robots.txt specifically blocks baiduspider ('Disallow: /') while other crawlers are allowed - this crawler will not index the site.

1 note(s):
  - no <lastmod> dates found - not required, but they help crawlers prioritize re-crawling changed pages.
```

## What it actually checks

- **robots.txt** (always fetched from the host root, per the robots
  exclusion protocol, even if the site itself is served from a subpath):
  flags `Disallow: /` under `User-agent: *` (blocks everyone), and flags a
  *specific* crawler (Googlebot/Bingbot/Baiduspider/Yandexbot) blocked by
  name while others are allowed - the kind of mistake that silently kills
  indexing on one search engine while the site looks fine on Google.
- **sitemap.xml**: fetched from the URL declared via `Sitemap:` in
  robots.txt if present, otherwise `sitemap.xml` next to the given site
  path. Flags a response that isn't actually a `<urlset>`/`<sitemapindex>`
  (e.g. a 200 OK HTML error page - a common silent failure), zero `<loc>`
  entries, and URLs that point to a different host than the site itself.
- **homepage meta robots**: flags a `noindex` in either the
  `<meta name="robots">` tag *or* the `X-Robots-Tag` HTTP header - the header
  variant is easy to miss because it never shows up in page source.

## Tests

```bash
npm test
```

25 tests using `node:test`, all HTTP calls are dependency-injected (a fake
`fetchImpl`), so the suite runs offline and deterministically - no real
network calls in tests. One of the tests is a regression check for a real
bug found while building this: a naive implementation normalized the target
URL down to the bare domain root, which silently broke robots.txt/sitemap
checks for any site served from a subpath (e.g. a GitHub Pages project
site) - robots.txt still has to come from the true host root per spec, but
the sitemap and homepage checks need to respect the given path.

## Related tools

Part of the same toolbox as
[dns-email-auth-checker](https://github.com/kleogeos/dns-email-auth-checker),
[freelance-invoice-cli](https://github.com/kleogeos/freelance-invoice-cli),
[sqlite-items-api](https://github.com/kleogeos/sqlite-items-api) and
[erc20-token-stats-api](https://github.com/kleogeos/erc20-token-stats-api) -
small, tested, zero/minimal-dependency backend tools.

## License

MIT
