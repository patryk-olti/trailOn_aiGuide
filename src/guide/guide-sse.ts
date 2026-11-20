/** Jedna ramka Server-Sent Events. JSON jest jedną linią, więc znaki nowej linii w tekście nie rozcinają zdarzenia. */
export function encodeSseEvent(event: string, data: unknown): string {
  const payload = JSON.stringify(data) ?? 'null';
  return `event: ${event}\ndata: ${payload}\n\n`;
}
