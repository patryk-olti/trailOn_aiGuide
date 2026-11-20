import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_NEARBY_RANGES,
  assistantAskedForDeparture,
  canonicalVoivodeship,
  formatAskForOrigin,
  formatNearbyRanges,
  formatNeedVoivodeship,
  fillDepartureArgs,
  latestStatedDeparture,
  mentionedVoivodeship,
  messageGivesDeparturePlace,
  messageWantsRangeSuggestion,
  resolveDeparturePlace,
  statedDepartureFromText,
  takeNearestRanges,
} from '../../dist/guide/guide-nearby-ranges.js';

const JORDANOW = [
  {
    name: 'Jordanów',
    latitude: 49.649,
    longitude: 19.83,
    country_code: 'PL',
    admin1: 'Województwo małopolskie',
    admin2: 'Powiat suski',
    population: 5194,
  },
  {
    name: 'Jordanów',
    latitude: 51.758,
    longitude: 19.676,
    country_code: 'PL',
    admin1: 'Województwo łódzkie',
    admin2: 'Powiat brzeziński',
    population: 269,
  },
  {
    name: 'Jordanów',
    latitude: 52.489,
    longitude: 19.735,
    country_code: 'PL',
    admin1: 'Województwo mazowieckie',
    population: 40,
  },
  {
    name: 'Jordanów Śląski',
    latitude: 50.864,
    longitude: 16.869,
    country_code: 'PL',
    admin1: 'Województwo dolnośląskie',
    population: 1000,
  },
  {
    name: 'Yordanovo',
    latitude: 42.017,
    longitude: 25.817,
    country_code: 'BG',
    admin1: 'Haskovo',
    population: 100,
  },
];

test('propozycja wyjazdu bez nazwy pasma jest pytaniem o najbliższe pasma', () => {
  assert.equal(MAX_NEARBY_RANGES, 3);
  assert.equal(messageWantsRangeSuggestion('Chcę pojechać w góry, co proponujesz?'), true);
  assert.equal(messageWantsRangeSuggestion('Poleć mi coś w górach'), true);
  assert.equal(messageWantsRangeSuggestion('Chcę wyjechać w Bieszczady'), false);
  assert.equal(messageWantsRangeSuggestion('Jaka pogoda na Śnieżce?'), false);
});

test('śląskie nie myli się z dolnośląskim', () => {
  assert.equal(canonicalVoivodeship('śląskie'), 'śląskie');
  assert.equal(canonicalVoivodeship('woj. dolnośląskie'), 'dolnośląskie');
  assert.equal(mentionedVoivodeship('jadę w dolnośląskie'), 'dolnośląskie');
  assert.equal(mentionedVoivodeship('Chcę pojechać w góry, co proponujesz?'), undefined);
});

test('miejscowość z województwem jest punktem startu, sama propozycja wyjazdu nie', () => {
  assert.equal(messageGivesDeparturePlace('Chcę pojechać w góry, co proponujesz?'), false);
  assert.equal(messageGivesDeparturePlace('Jadę z Krakowa, małopolskie'), true);
  assert.equal(messageGivesDeparturePlace('Kraków, woj. małopolskie'), true);
});

test('ta sama miejscowość w kilku województwach wymaga doprecyzowania', () => {
  const place = resolveDeparturePlace(JORDANOW, 'Jordanów', undefined);
  assert.equal(place.kind, 'need_voivodeship');
  assert.deepEqual(place.voivodeships, ['małopolskie', 'łódzkie', 'mazowieckie']);
  const copy = formatNeedVoivodeship(place.locality, place.voivodeships);
  assert.match(copy.reply, /małopolskie, łódzkie, mazowieckie/);
  assert.match(copy.reply, /województwo/);
  assert.equal(copy.reply.includes('49.649'), false);
});

test('województwo wybiera właściwy Jordanów', () => {
  const place = resolveDeparturePlace(JORDANOW, 'z Jordanowa', 'małopolskie');
  assert.equal(place.kind, 'ready');
  assert.equal(place.lat, 49.649);
  assert.equal(place.lng, 19.83);
  assert.equal(place.voivodeship, 'małopolskie');
});

test('złe województwo nie podstawia innego', () => {
  const place = resolveDeparturePlace(JORDANOW, 'Jordanów', 'podkarpackie');
  assert.equal(place.kind, 'not_found');
  assert.equal(place.voivodeship, 'podkarpackie');
  assert.ok(place.elsewhere.includes('małopolskie'));
});

test('bez GPS prośba zawiera miejscowość i województwo', () => {
  const copy = formatAskForOrigin();
  assert.match(copy.reply, /snapshot GPS/);
  assert.match(copy.reply, /miejscowość i województwo/);
  assert.match(copy.instruction, /Nie wymieniaj pasm/);
});

test('z wielu szczytów zostają najwyżej 3 najbliższe pasma', () => {
  const ranges = takeNearestRanges(
    [
      { peak_id: 'a', name: 'Leskowiec', elevation_m: 922, range_name: 'Beskid Mały', distance_km: 48.2 },
      { peak_id: 'b', name: 'Łamana Skała', elevation_m: 929, range_name: 'Beskid Mały', distance_km: 51 },
      { peak_id: 'c', name: 'Turbacz', elevation_m: 1310, range_name: 'Gorce', distance_km: 71 },
      { peak_id: 'd', name: 'Babia Góra', elevation_m: 1725, range_name: 'Beskid Żywiecki', distance_km: 62.4 },
      { peak_id: 'e', name: 'Rysy', elevation_m: 2499, range_name: 'Tatry', distance_km: 90 },
    ],
    3,
  );
  assert.deepEqual(
    ranges.map((range) => range.peak_id),
    ['a', 'd', 'c'],
  );
  const copy = formatNearbyRanges('Twojej pozycji (snapshot GPS)', ranges);
  assert.match(copy.reply, /Beskid Mały/);
  assert.match(copy.reply, /48,2 km do Leskowiec \(922 m\.n\.p\.m\.\)/);
  assert.match(copy.reply, /Babia Góra/);
  assert.match(copy.reply, /Turbacz/);
  assert.equal(copy.reply.includes('Rysy'), false);
  assert.match(copy.instruction, /id=a/);
});

test('miejsce podane w wątku zostaje, dopóki użytkownik nie wskaże innego', () => {
  assert.deepEqual(statedDepartureFromText('Kraków, woj. małopolskie'), {
    locality: 'Kraków',
    voivodeship: 'małopolskie',
  });
  assert.deepEqual(statedDepartureFromText('Jadę z Krakowa, małopolskie'), {
    locality: 'Krakowa',
    voivodeship: 'małopolskie',
  });
  assert.deepEqual(
    statedDepartureFromText('Liczę od Kraków (woj. małopolskie). Najbliższe pasma:'),
    { locality: 'Kraków', voivodeship: 'małopolskie' },
  );
  assert.equal(statedDepartureFromText('Chcę pojechać w góry, co proponujesz?'), undefined);
  assert.equal(statedDepartureFromText('Jaka będzie pogoda w weekend?'), undefined);

  const thread = [
    'Żebym mógł zaproponować pasma, napisz miejscowość i województwo.',
    'Kraków, woj. małopolskie',
    'Liczę od Kraków (woj. małopolskie). Najbliższe pasma — Beskid Żywiecki.',
    'Jaka będzie pogoda w weekend?',
  ];
  assert.deepEqual(latestStatedDeparture(thread), {
    locality: 'Kraków',
    voivodeship: 'małopolskie',
  });
  assert.deepEqual(
    latestStatedDeparture([...thread, 'Jadę z Zakopanego, małopolskie']),
    { locality: 'Zakopanego', voivodeship: 'małopolskie' },
  );
  assert.deepEqual(
    fillDepartureArgs({ limit: 3 }, { locality: 'Kraków', voivodeship: 'małopolskie' }),
    { locality: 'Kraków', voivodeship: 'małopolskie' },
  );
  assert.deepEqual(
    fillDepartureArgs(
      { locality: 'Zakopane' },
      { locality: 'Kraków', voivodeship: 'małopolskie' },
    ),
    { locality: 'Zakopane', voivodeship: undefined },
  );
});

test('wcześniejsza prośba o miejscowość i województwo zostaje w historii', () => {
  assert.equal(
    assistantAskedForDeparture([
      'Żebym mógł zaproponować pasma, napisz miejscowość i województwo.',
    ]),
    true,
  );
  assert.equal(assistantAskedForDeparture(['Hej, jestem prywatnym przewodnikiem górskim.']), false);
});
