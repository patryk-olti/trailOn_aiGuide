/** Etykiety jak w PeakWeatherCard / WallSidebar w repo peak (WMO weather_code). */
export function weatherCodeLabelPl(code: number): string {
  if (code === 0) {
    return 'bezchmurnie';
  }
  if (code <= 3) {
    return 'zachmurzenie / przejaśnienia';
  }
  if (code === 45 || code === 48) {
    return 'mgła';
  }
  if (code <= 67) {
    return 'deszcz lub mżawka';
  }
  if (code <= 77) {
    return 'śnieg lub przelotne opady śniegu';
  }
  if (code <= 82) {
    return 'przelotne opady';
  }
  return 'burza lub silne opady';
}