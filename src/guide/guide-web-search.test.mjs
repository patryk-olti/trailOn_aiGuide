import assert from 'node:assert/strict';
import test from 'node:test';
import { plainTextToGuideHtml } from '../../dist/guide/guide-response-html.js';
import { formatMountainWebBrief } from '../../dist/guide/guide-web-search.js';
import { isMountainIndustryUrl } from '../../dist/guide/mountain-sources.js';

test('domena służby i subdomena są branżowe, wikipedia nie', () => {
  assert.equal(isMountainIndustryUrl('https://topr.pl/komunikat'), true);
  assert.equal(isMountainIndustryUrl('https://pogoda.topr.pl/'), true);
  assert.equal(isMountainIndustryUrl('https://www.gopr.pl/'), true);
  assert.equal(isMountainIndustryUrl('https://pl.wikipedia.org/wiki/Rysy'), false);
  assert.equal(isMountainIndustryUrl('https://nottopr.pl/'), false);
});

test('brief zostawia tylko cytowania branżowe', () => {
  const brief = formatMountainWebBrief(
    'Szlak na Rysy jest zamknięty. https://pl.wikipedia.org/wiki/Rysy',
    [
      { title: 'Komunikat', url: 'https://tpn.gov.pl/komunikat-turystyczny' },
      { title: 'Wiki', url: 'https://pl.wikipedia.org/wiki/Rysy' },
    ],
  );
  assert.equal(brief.sources.length, 1);
  assert.equal(brief.sources[0].url, 'https://tpn.gov.pl/komunikat-turystyczny');
  assert.equal(brief.text.includes('wikipedia'), false);
  assert.match(brief.text, /Szlak na Rysy jest zamknięty/);
});

test('bez cytowania branżowego nie przepuszcza tekstu z sieci', () => {
  const brief = formatMountainWebBrief('Stolica Francji to Paryż.', [
    { title: 'Wiki', url: 'https://pl.wikipedia.org/wiki/Paryz' },
  ]);
  assert.equal(brief.sources.length, 0);
  assert.match(brief.text, /nie masz pewnej informacji/);
  assert.equal(brief.text.includes('Paryż'), false);
});

test('adres TOPR staje się linkiem, obca strona zostaje tekstem', () => {
  const html = plainTextToGuideHtml(
    'Komunikat: https://topr.pl/lawiny. Reszta: https://example.com/x',
    new Map(),
  );
  assert.match(html, /href="https:\/\/topr\.pl\/lawiny"/);
  assert.match(html, />TOPR</);
  assert.equal(html.includes('href="https://example.com/x"'), false);
  assert.match(html, /example\.com/);
});
