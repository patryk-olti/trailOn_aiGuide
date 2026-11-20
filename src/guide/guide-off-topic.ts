import { normalizePeakName } from '../rag/rag-blog-lookup';

/** Kolejne warianty gadki spoza gór. W jednej rozmowie nie powtarzamy tego samego. */
export const OFF_TOPIC_REPLIES = [
  'Hej, jestem prywatnym przewodnikiem górskim — pomagam przy górach: szlakach, szczytach, pogodzie na trasie i tym, jak iść bezpiecznie. W innych sprawach nie wchodzę, bo to nie moja działka. Jak będziesz chciał ruszyć w góry, jestem: ułożymy trasę albo sprawdzimy, co dzieje się na szlaku.',
  'Prowadzę tylko po górach. Szlak, szczyt, pogoda i to, czy da się iść bezpiecznie — tyle ogarniam. Poza tym nie pomagam. Jak zbierzesz się na wyjście, ułożymy trasę albo sprawdzimy szlak.',
  'Jestem przewodnikiem trailON i zostaję przy górach. Nie biorę przepisów, pracy ani tematów spoza szlaku. Daj znać, dokąd chcesz ruszyć, to sprawdzimy trasę.',
  'Góry to moja działka: gdzie iść, na który szczyt i jaka jest pogoda po drodze. Na resztę nie odpowiem. Jak zaplanujesz wyprawę, jestem pod ręką.',
  'Tu jestem przewodnikiem, nie od wszystkiego. Szlaki, szczyty i bezpieczne wyjście — tak. Inne sprawy odpuszczam. Powiedz, kiedy ruszasz w góry.',
] as const;

export const MOUNTAIN_UNKNOWN_REPLY =
  'To pytanie jest o góry, ale nie mam na nie potwierdzonej odpowiedzi w materiałach trailON. Nie zgaduję.';

export const MAP_UNKNOWN_REPLY =
  'Nie pokażę tego na mapie — nie ma tego na liście szczytów trailON. Jak podasz szczyt z katalogu, otworzę go na mapie.';

const MOUNTAIN_TALK =
  /\b(gory|gorach|gorami|gorski\w*|szczyt\w*|szlak\w*|pasmo|pasmie|pogod\w*|tras\w*|map\w*|wyciecz\w*|wejsc\w*|wejsci\w*|karkonos\w*|tatr\w*|beskid\w*|bieszcz\w*|sudet\w*|pienin\w*|koron\w*|wysokosc\w*)\b/;

export function pickOffTopicReply(priorAssistantTexts: readonly string[]): string {
  const foldedPrior = priorAssistantTexts.map((text) => normalizePeakName(text));
  const unused = OFF_TOPIC_REPLIES.find((reply) => !foldedPrior.some((text) => text.includes(replyMarker(reply))));
  if (unused) {
    return unused;
  }
  let best: string = OFF_TOPIC_REPLIES[0];
  let bestIndex = Number.POSITIVE_INFINITY;
  OFF_TOPIC_REPLIES.forEach((reply) => {
    const marker = replyMarker(reply);
    let last = -1;
    foldedPrior.forEach((text, index) => {
      if (text.includes(marker)) {
        last = index;
      }
    });
    if (last < bestIndex) {
      bestIndex = last;
      best = reply;
    }
  });
  return best;
}

export function isOffTopicGuideReply(text: string): boolean {
  const folded = normalizePeakName(text);
  return OFF_TOPIC_REPLIES.some((reply) => folded.includes(replyMarker(reply)));
}

export function messageAsksToShowOnMap(message: string): boolean {
  return /\bmap/.test(normalizePeakName(message));
}

/** Pytanie zostaje przy górach, także jako ciąg wcześniejszej rozmowy o szlaku albo mapie. */
export function messageStaysOnMountains(message: string, priorUserTexts: readonly string[]): boolean {
  if (MOUNTAIN_TALK.test(normalizePeakName(message))) {
    return true;
  }
  const priorMountain = priorUserTexts.some((text) => MOUNTAIN_TALK.test(normalizePeakName(text)));
  if (!priorMountain) {
    return false;
  }
  const folded = normalizePeakName(message);
  return (
    /^(a |i |to |ten |ta |te |pokaz|otworz|zobacz|no |jeszcze|dalej|wiecej)/.test(folded) ||
    (folded.length > 0 && folded.length < 48 && /\b(to|ten|ta|te|tam)\b/.test(folded))
  );
}

function replyMarker(reply: string): string {
  return normalizePeakName(reply).slice(0, 42);
}
