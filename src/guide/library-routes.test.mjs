import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLibraryRouteProposals,
  messageAsksForRoute,
  parseLibraryPlan,
  rankLibraryRoutes,
} from '../../dist/guide/library-routes.js';

const BISKUPIA = {
  identyfikator: 'plan-1789152828922-npictg',
  nazwa: 'Biskupia Kopa',
  pasmo: 'Góry Opawskie',
  trudnosc: 'Łatwy',
  dlugosc_km: 9.3,
  url: 'https://trailon.pl/plan/library?planId=plan-1789152828922-npictg',
  punkty_kontrolne: [
    { nazwa: 'Parking przy Hotelu Ziemowit', km_od_startu: 0 },
    { nazwa: 'Biskupia Kopa', km_od_startu: 4.2 },
  ],
  gpx: '<?xml version="1.0"?><gpx version="1.1"></gpx>',
};

const SNIEZKA = {
  identyfikator: 'plan-sniezka',
  nazwa: 'Śnieżka z Karpacza',
  pasmo: 'Karkonosze',
  trudnosc: 'Średni',
  dlugosc_km: 12,
  url: 'https://trailon.pl/plan/library?planId=plan-sniezka',
  punkty_kontrolne: [{ nazwa: 'Karpacz' }],
};

function plan(key, payload) {
  return parseLibraryPlan(key, JSON.stringify(payload));
}

test('pytanie o trasę na Biskupią Kopę wybiera plan z biblioteki', () => {
  const routes = [
    plan('biblioteka-tras/sniezka.json', SNIEZKA),
    plan('biblioteka-tras/biskupia.json', BISKUPIA),
  ];
  const ranked = rankLibraryRoutes(routes, 'Jaka trasa na Biskupią Kopę?', 3);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, 'Biskupia Kopa');
  const text = formatLibraryRouteProposals(ranked);
  assert.match(text, /https:\/\/trailon\.pl\/plan\/library\?planId=plan-1789152828922-npictg/);
  assert.match(text, /9\.3 km/);
  assert.match(text, /ślad GPX: tak/);
  assert.equal(text.includes('<gpx'), false);
});

test('pasmo w odmianie trafia w plan z tego pasma', () => {
  const routes = [plan('biblioteka-tras/biskupia.json', BISKUPIA)];
  const ranked = rankLibraryRoutes(routes, 'trasa w Górach Opawskich', 3);
  assert.equal(ranked[0]?.name, 'Biskupia Kopa');
});

test('pytanie o pogodę nie jest pytaniem o trasę', () => {
  assert.equal(messageAsksForRoute('jaka trasa na Biskupią Kopę'), true);
  assert.equal(messageAsksForRoute('jaka pogoda na Śnieżce'), false);
});
