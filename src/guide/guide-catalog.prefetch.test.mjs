import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractLooseRange,
  placeAskedAbout,
  planCatalogPrefetch,
} from '../../dist/guide/guide-catalog.prefetch.js';
import { messagePlansTrip } from '../../dist/guide/library-routes.js';

test('wyjazd w Bieszczady ładuje katalog tego pasma', () => {
  const plan = planCatalogPrefetch('Chcę wyjechać w bieszczady');
  assert.equal(plan?.peaks?.range, 'Bieszczady');
  assert.equal(plan?.peaks?.limit, 3);
  assert.match(plan?.materials?.query ?? '', /Bieszczady/);
  assert.equal(messagePlansTrip('Chcę wyjechać w bieszczady'), true);
});

test('pytanie o szczyty w Tatrach nadal trafia w pasmo', () => {
  const plan = planCatalogPrefetch('jakie szczyty w Tatrach');
  assert.equal(plan?.peaks?.range, 'Tatry');
});

test('góry kaczawskie są nazwaniem pasma, a Grodziec szczytem', () => {
  const loose = extractLooseRange('Chce jechać w góry kaczawskie co polecasz');
  assert.equal(loose?.like, 'kaczawsk');
  assert.equal(loose?.preferPrefix, 'Góry');
  assert.equal(extractLooseRange('A co jest obok gór kaczawskich?')?.like, 'kaczawsk');
  assert.equal(extractLooseRange('co jest obok pogórza kaczawskiego')?.preferPrefix, 'Pogórze');
  assert.equal(extractLooseRange('Chcę pojechać w góry, co proponujesz?'), undefined);
  assert.equal(placeAskedAbout('Co jest przy Grodziec?'), 'Grodziec');
  assert.equal(placeAskedAbout('A co jest obok gór kaczawskich?'), undefined);

  const plan = planCatalogPrefetch('Chce jechać w góry kaczawskie co polecasz');
  assert.equal(plan?.peaks?.range, 'Góry kaczawsk');
  assert.match(plan?.materials?.query ?? '', /kaczawskie/);
});

test('pytanie spoza gór nie ładuje katalogu szczytów', () => {
  assert.equal(planCatalogPrefetch('przepis na pierogi'), undefined);
  assert.equal(planCatalogPrefetch('chcę wyjechać nad morze'), undefined);
  assert.equal(messagePlansTrip('chcę wyjechać nad morze'), true);
});
