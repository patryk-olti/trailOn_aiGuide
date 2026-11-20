import assert from 'node:assert/strict';
import test from 'node:test';
import { planCatalogPrefetch } from '../../dist/guide/guide-catalog.prefetch.js';
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

test('pytanie spoza gór nie ładuje katalogu szczytów', () => {
  assert.equal(planCatalogPrefetch('przepis na pierogi'), undefined);
  assert.equal(planCatalogPrefetch('chcę wyjechać nad morze'), undefined);
  assert.equal(messagePlansTrip('chcę wyjechać nad morze'), true);
});
