import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotatePeakElevations,
  annotatePeakMapLinks,
  collectCitedBlogUrls,
  formatCatalogPeakMapReply,
  lastMentionedPeakNames,
  plainTextToGuideHtml,
  presentBlogLinkLine,
  stripMismatchedPeakBlogUrls,
  stripTrailingOffer,
  suppressRepeatedBlogLinks,
} from '../../dist/guide/guide-response-html.js';
import {
  isOffTopicGuideReply,
  MAP_UNKNOWN_REPLY,
  messageAsksToShowOnMap,
  messageStaysOnMountains,
  OFF_TOPIC_REPLIES,
  pickOffTopicReply,
} from '../../dist/guide/guide-off-topic.js';
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

test('przy nazwie szczytu dopisuje wysokość w nawiasach', () => {
  const peaks = [
    { name: 'Małołączniak', elevationM: 2096 },
    { name: 'Babia Góra', elevationM: 1725 },
    { name: 'Babia', elevationM: 1000 },
  ];
  assert.equal(
    annotatePeakElevations('Wejdź na Małołączniak od strony Doliny.', peaks),
    'Wejdź na Małołączniak (2096 m.n.p.m.) od strony Doliny.',
  );
  assert.equal(
    annotatePeakElevations('Małołączniak (2096 m, Czerwone Wierchy) i Babia Góra — 1725 m n.p.m.', peaks),
    'Małołączniak (2096 m.n.p.m.) i Babia Góra (1725 m.n.p.m.)',
  );
  assert.equal(
    annotatePeakElevations('Ze szlaku na Małołączniaka.', peaks),
    'Ze szlaku na Małołączniaka (2096 m.n.p.m.).',
  );
  assert.equal(
    annotatePeakElevations('**Małołączniak** jest blisko.', peaks),
    '**Małołączniak (2096 m.n.p.m.)** jest blisko.',
  );
  assert.equal(
    annotatePeakElevations('Małołączniak (2096 m.n.p.m.) został.', peaks),
    'Małołączniak (2096 m.n.p.m.) został.',
  );
  assert.equal(
    annotatePeakElevations(
      'Małołączniak (2020 m.n.p.m.) to szczyt w Czerwonych Wierchach.',
      peaks,
    ),
    'Małołączniak (2096 m.n.p.m.) to szczyt w Czerwonych Wierchach.',
  );
  const url = 'https://trailon.pl/przewodnik/tatry/Małołączniak';
  assert.equal(annotatePeakElevations(`Opis: ${url}.`, peaks), `Opis: ${url}.`);
  assert.equal(
    annotatePeakElevations('Małołączniakowy grzbiet.', peaks),
    'Małołączniakowy grzbiet.',
  );
});

test('kompletna odpowiedź nie kończy się zaproszeniem do kolejnego pytania', () => {
  const answer = [
    'Małołączniak (2096 m.n.p.m.) leży w Czerwonych Wierchach.',
    '',
    'Jeśli potrzebujesz więcej informacji lub chcesz zaplanować trasę, daj znać!',
  ].join('\n');
  assert.equal(
    stripTrailingOffer(answer),
    'Małołączniak (2096 m.n.p.m.) leży w Czerwonych Wierchach.',
  );
  assert.equal(
    stripTrailingOffer(
      'Szlak jest otwarty. Jeśli potrzebujesz więcej informacji lub chcesz zaplanować trasę, daj znać!',
    ),
    'Szlak jest otwarty.',
  );
  assert.equal(
    stripTrailingOffer('Nie mam pogody bez szczytu. Daj znać, który z tych trzech wybierasz.'),
    'Nie mam pogody bez szczytu. Daj znać, który z tych trzech wybierasz.',
  );
});

test('szczyt z listy dostaje link mapy, szczyt bez id nie', () => {
  const text = 'Śnieżka leży na granicy.\nObok jest punkt, którego nie ma w katalogu.';
  const next = annotatePeakMapLinks(text, [
    { id: 'sniezka', name: 'Śnieżka', elevationM: 1602 },
    { name: 'Chojnik', elevationM: 627 },
  ]);
  assert.match(next, /https:\/\/trailon\.pl\/map\?peakId=sniezka/);
  const html = plainTextToGuideHtml(next, new Map());
  assert.match(html, />Sprawdź na mapie<\/a>/);
  assert.match(html, /data-trailon-peak-id="sniezka"/);
  assert.equal(html.includes('target='), false);
  const fromLeadIn = plainTextToGuideHtml('Na mapie: https://trailon.pl/map?peakId=sniezka', new Map());
  assert.match(fromLeadIn, />Sprawdź na mapie<\/a>/);
  assert.equal(fromLeadIn.includes('Na mapie'), false);
  assert.equal(next.includes('peakId=chojnik'), false);
  const again = annotatePeakMapLinks(next, [{ id: 'sniezka', name: 'Śnieżka', elevationM: 1602 }]);
  assert.equal(again.split('peakId=sniezka').length - 1, 1);
});

test('odmiana nazwy nadal trafia w szczyt do mapy', () => {
  const names = lastMentionedPeakNames('Czy możesz pokazać Śnieżkę na mapie?', [{ name: 'Śnieżka' }], 1);
  assert.deepEqual(names, ['Śnieżka']);
});

test('prośba o mapę bez szczytu na liście mówi wprost, a gadka się zmienia', () => {
  assert.equal(messageAsksToShowOnMap('czy możesz pokazać na mapie?'), true);
  assert.equal(messageStaysOnMountains('czy możesz pokazać na mapie?', []), true);
  assert.equal(messageStaysOnMountains('jaki jest przepis na rosół?', []), false);
  assert.equal(isOffTopicGuideReply(OFF_TOPIC_REPLIES[0]), true);
  assert.equal(isOffTopicGuideReply('Śnieżka ma 1602 m.n.p.m.'), false);
  const first = pickOffTopicReply([]);
  const second = pickOffTopicReply([first]);
  assert.notEqual(first, second);
  assert.equal(formatCatalogPeakMapReply([]), '');
  assert.match(MAP_UNKNOWN_REPLY, /nie ma tego na liście/);
});

test('link do trasy nie jest traktowany jak blog', () => {
  const cited = collectCitedBlogUrls([TRASA]);
  assert.equal(cited.size, 0);
  const next = suppressRepeatedBlogLinks(`${TRASA} i jeszcze ${TRASA}`, cited);
  assert.equal(next.split(TRASA).length - 1, 2);
});
