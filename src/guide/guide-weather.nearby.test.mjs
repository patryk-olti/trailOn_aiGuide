import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEATHER_NEARBY_RADIUS_KM,
  formatUnansweredWeather,
} from '../../dist/guide/guide-weather.tool.js';

const KALENICA = {
  peak_id: 'kalenica',
  name: 'Kalenica',
  elevation_m: 964,
  range_name: 'Góry Sowie',
  distance_km: 2.4,
};

test('promień dopytania o pogodę ma 5 km', () => {
  assert.equal(WEATHER_NEARBY_RADIUS_KM, 5);
});

test('bez punktu prosi o lokalizację albo nazwę szczytu', () => {
  const text = formatUnansweredWeather('Brak szczytu.', undefined);
  assert.match(text, /Nie zgaduj prognozy/);
  assert.match(text, /Brak punktu użytkownika/);
  assert.equal(text.includes('Kalenica'), false);
});

test('dopytuje tylko o szczyty w promieniu 5 km', () => {
  const text = formatUnansweredWeather('Brak szczytu.', [KALENICA]);
  assert.match(text, /Dopytaj użytkownika/);
  assert.match(text, /maksymalnie 5 km/);
  assert.match(text, /Kalenica \(964 m, Góry Sowie, 2\.4 km, id=kalenica\)/);
  assert.match(text, /Nie wymieniaj dalszych/);
});

test('pusty promień 5 km nie poszerza szukania', () => {
  const text = formatUnansweredWeather('Brak szczytu.', []);
  assert.match(text, /W promieniu 5 km/);
  assert.match(text, /Nie poszerzaj promienia/);
  assert.equal(text.includes('Dopytaj użytkownika, o który'), false);
});
