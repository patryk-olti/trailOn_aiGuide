import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectCitedBlogUrls,
  plainTextToGuideHtml,
  presentBlogLinkLine,
  stripMismatchedPeakBlogUrls,
  suppressRepeatedBlogLinks,
} from '../../dist/guide/guide-response-html.js';
import { blogIdentityMatchesPeak } from '../../dist/rag/rag-blog-lookup.js';

const SNIEZKA = 'https://trailon.pl/przewodnik/karkonosze/sniezka';
const SZRENICA = 'https://trailon.pl/przewodnik/karkonosze/szrenica';
const TRASA = 'https://trailon.pl/trasy/karkonosze/sniezka-petla';

test('drugie pytanie o ten sam szczyt nie dostaje znowu linku do bloga', () => {
  const cited = collectCitedBlogUrls([
    `Śnieżka ma 1603 m. Więcej: ${SNIEZKA}`,
  ]);
  const next = suppressRepeatedBlogLinks(
    `Na szczycie wieje. Szczegóły: ${SNIEZKA}. Szrenica: ${SZRENICA}.`,
    cited,
  );
  assert.equal(next.includes(SNIEZKA), false);
  assert.equal(next.includes(SZRENICA), true);
  assert.equal(next.includes('Szczegóły'), false);
  assert.match(next, /^Na szczycie wieje\. Szrenica:/);
});

test('w jednej odpowiedzi ten sam blog jest linkowany tylko raz', () => {
  const next = suppressRepeatedBlogLinks(
    `Najpierw ${SNIEZKA}, a potem jeszcze raz ${SNIEZKA}.`,
    new Set(),
  );
  const occurrences = next.split(SNIEZKA).length - 1;
  assert.equal(occurrences, 1);
});

test('markdown do już podanego bloga zostaje samym tytułem', () => {
  const cited = collectCitedBlogUrls([`Zobacz [Śnieżka](${SNIEZKA}).`]);
  const next = suppressRepeatedBlogLinks(`Polecam [Śnieżka](${SNIEZKA}) na weekend.`, cited);
  assert.equal(next.includes(SNIEZKA), false);
  assert.match(next, /Polecam Śnieżka na weekend/);
});

test('adres z ukośnikiem i query liczy się jako ten sam wpis', () => {
  const cited = collectCitedBlogUrls([`${SNIEZKA}/?utm=1`]);
  const next = suppressRepeatedBlogLinks(`Powtórka ${SNIEZKA}.`, cited);
  assert.equal(next.includes('trailon.pl/przewodnik'), false);
});

test('między ostatnim podpunktem a kolejnym numerem jest większy odstęp', () => {
  const html = plainTextToGuideHtml(
    [
      '1. Trzy Korony (Pieniny)',
      'Czas przejścia: około 3-4 godziny w jedną stronę.',
      'Link do bloga: Trzy Korony - najbardziej charakterystyczny szczyt polski?',
      '2. Kłodzka Góra (Góry Bardzkie)',
      'Czas przejścia: około 2-3 godziny w jedną stronę.',
      'Link do bloga: Kłodzka Góra i spacer nad kotliną.',
      '3. Bukowina Waksmundzka (Gorce)',
      'Atrakcje: panorama Tatr.',
    ].join('\n'),
    new Map(),
  );
  assert.match(html, /<p style="margin-top:1\.6em">2\. Kłodzka Góra/);
  assert.match(html, /<p style="margin-top:1\.6em">3\. Bukowina Waksmundzka/);
  assert.equal(html.startsWith('<p>1. Trzy Korony'), true);
  assert.equal(html.includes('polski?<br/>2. Kłodzka'), false);
  assert.equal(html.includes('stronę.<br/>Link do bloga: Trzy Korony'), true);
});

test('slug innego szczytu nie jest adresem Kalenicy', () => {
  const foreign = 'https://trailon.pl/przewodnik/gory-bardzkie/klodzka-gora';
  const own = 'https://trailon.pl/przewodnik/gory-sowie/kalenica';
  assert.equal(blogIdentityMatchesPeak('Kalenica', { url: foreign }), false);
  assert.equal(blogIdentityMatchesPeak('Kalenica', { url: own }), true);
  assert.equal(blogIdentityMatchesPeak('Wielka Sowa', { url: 'https://trailon.pl/przewodnik/gory-sowie/wielka-sowa' }), true);
  assert.equal(blogIdentityMatchesPeak('Wielka Sowa', { url: 'https://trailon.pl/przewodnik/gory-sowie/mala-sowa' }), false);
});

test('przy szczycie zostaje tylko jego potwierdzony URL', () => {
  const wielka = 'https://trailon.pl/przewodnik/gory-sowie/wielka-sowa';
  const klodzka = 'https://trailon.pl/przewodnik/gory-bardzkie/klodzka-gora';
  const text = [
    'Wielka Sowa (1015 m n.p.m.)',
    `URL: ${wielka}`,
    'Kalenica (964 m n.p.m.)',
    `URL: ${klodzka}`,
    'Mała Sowa (972 m n.p.m.)',
    'Brak wpisu blogowego.',
  ].join('\n');
  const next = stripMismatchedPeakBlogUrls(text, [
    { name: 'Wielka Sowa', url: wielka },
    { name: 'Kalenica' },
    { name: 'Mała Sowa' },
  ]);
  assert.equal(next.includes(wielka), true);
  assert.equal(next.includes(klodzka), false);
  assert.match(next, /Kalenica \(964 m n\.p\.m\.\)/);
  assert.equal(next.includes('URL:'), true);
  assert.equal(next.split('URL:').length - 1, 1);
});

test('adres wpisu jest opisany jako link do bloga', () => {
  assert.equal(presentBlogLinkLine(`URL: ${SNIEZKA}`), `Link do bloga: ${SNIEZKA}`);
  assert.equal(presentBlogLinkLine(SNIEZKA), `Link do bloga: ${SNIEZKA}`);
  assert.equal(presentBlogLinkLine(`Link do bloga: ${SNIEZKA}`), `Link do bloga: ${SNIEZKA}`);
  assert.equal(presentBlogLinkLine(TRASA), TRASA);

  const html = plainTextToGuideHtml(
    ['Wielka Sowa (1015 m n.p.m.)', `URL: ${SNIEZKA}`].join('\n'),
    new Map([[SNIEZKA, 'Śnieżka']]),
  );
  assert.match(html, /Link do bloga: <a href="https:\/\/trailon\.pl\/przewodnik\/karkonosze\/sniezka"/);
  assert.match(html, />Śnieżka<\/a>/);
  assert.equal(html.includes('URL:'), false);
});

test('link do trasy nie jest traktowany jak blog', () => {
  const cited = collectCitedBlogUrls([TRASA]);
  assert.equal(cited.size, 0);
  const next = suppressRepeatedBlogLinks(`${TRASA} i jeszcze ${TRASA}`, cited);
  assert.equal(next.split(TRASA).length - 1, 2);
});
