#!/usr/bin/env node
'use strict';

const { auditSite } = require('../src/auditor');

function parseArgs(argv) {
  const args = { site: null, json: false };
  for (const arg of argv) {
    if (arg === '--json') {
      args.json = true;
    } else if (!arg.startsWith('--')) {
      args.site = arg;
    }
  }
  return args;
}

function printReport(report) {
  console.log(`\nSEO index audit: ${report.site}\n`);

  console.log(`robots.txt: ${report.robots.fetched ? 'found' : 'not found / unreachable'}`);
  console.log(`sitemap: ${report.sitemap && report.sitemap.fetched ? `found (${report.sitemap.urlCount ?? 0} URLs)` : 'not found / unreachable'}`);
  console.log(`homepage: ${report.homepage && report.homepage.fetched ? `reachable (HTTP ${report.homepage.status})` : 'unreachable'}`);

  if (report.issues.length === 0) {
    console.log('\nNo blocking issues found.');
  } else {
    console.log(`\n${report.issues.length} issue(s) found:`);
    for (const issue of report.issues) console.log(`  ! ${issue}`);
  }

  if (report.notes.length > 0) {
    console.log(`\n${report.notes.length} note(s):`);
    for (const note of report.notes) console.log(`  - ${note}`);
  }
  console.log('');
}

async function main() {
  const { site, json } = parseArgs(process.argv.slice(2));
  if (!site) {
    console.error('Usage: seo-index-audit-cli <domain-or-url> [--json]');
    process.exitCode = 1;
    return;
  }

  try {
    const report = await auditSite({ url: site });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    process.exitCode = report.issues.length > 0 ? 2 : 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
