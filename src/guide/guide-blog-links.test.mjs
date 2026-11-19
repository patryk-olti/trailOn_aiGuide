import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectCitedBlogUrls,
  suppressRepeatedBlogLinks,
} from '../../dist/guide/guide-response-html.js';

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

test('link do trasy nie jest traktowany jak blog', () => {
  const cited = collectCitedBlogUrls([TRASA]);
  assert.equal(cited.size, 0);
  const next = suppressRepeatedBlogLinks(`${TRASA} i jeszcze ${TRASA}`, cited);
  assert.equal(next.split(TRASA).length - 1, 2);
});
