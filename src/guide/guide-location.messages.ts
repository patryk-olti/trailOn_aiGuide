export const LOCATION_REQUIRED_USER_HINT =
  'Aby wyszukać szczyty w pobliżu (odległość, promień, „najbliższy”, „ode mnie”), aplikacja musi przekazać w żądaniu POST /guide pole location z szerokością i długością geogr. (np. z GPS). ' +
  'Opcjonalnie **radiusKm** (domyślnie 100 km). Bez tych danych nie da się policzyć odległości do szczytów w katalogu.';

export const LOCATION_REQUIRED_TOOL_RESULT =
  'Brak pozycji użytkownika: w żądaniu API nie ma pola location (lat, lng), a wyszukiwanie wymaga współrzędnych lub promienia. ' +
  'Nie uruchamiaj zgadywania lokalizacji. Przekaż użytkownikowi, że powinien włączyć lokalizację w aplikacji TrailOn lub ponowić zapytanie z location w body. ' +
  'Przykład: {"message":"...","location":{"lat":50.06,"lng":19.94,"radiusKm":100}}.';

const PROXIMITY_PATTERN =
  /\b(w pobli[żz]u|blisko|ode mnie|najbli[żz]szy|najbli[żz]sza|w promieniu|w okolicy|km od|kilometr[óo]w od|mojej lokalizacji|moj[ąa] lokalizacj|przy mnie|gdzie jestem)\b/i;

export function messageImpliesProximity(message: string): boolean {
  return PROXIMITY_PATTERN.test(message.trim());
}