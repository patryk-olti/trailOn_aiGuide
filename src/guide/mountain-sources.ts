/** Służby, parki i organizacje górskie. Subdomeny wchodzą razem z domeną. */
export const MOUNTAIN_INDUSTRY_SOURCES: ReadonlyArray<{ domain: string; label: string }> = [
  { domain: 'topr.pl', label: 'TOPR' },
  { domain: 'gopr.pl', label: 'GOPR' },
  { domain: 'pttk.pl', label: 'PTTK' },
  { domain: 'pza.org.pl', label: 'PZA' },
  { domain: 'imgw.pl', label: 'IMGW' },
  { domain: 'tpn.gov.pl', label: 'Tatrzański Park Narodowy' },
  { domain: 'kpn.gov.pl', label: 'Karkonoski Park Narodowy' },
  { domain: 'bdpn.pl', label: 'Bieszczadzki Park Narodowy' },
  { domain: 'bgpn.pl', label: 'Babiogórski Park Narodowy' },
  { domain: 'gorczanskipark.pl', label: 'Gorczański Park Narodowy' },
  { domain: 'pieninypn.pl', label: 'Pieniński Park Narodowy' },
  { domain: 'magurskipn.pl', label: 'Magurski Park Narodowy' },
  { domain: 'swietokrzyskipn.org.pl', label: 'Świętokrzyski Park Narodowy' },
  { domain: 'pngs.com.pl', label: 'Park Narodowy Gór Stołowych' },
  { domain: 'ojcowskiparknarodowy.pl', label: 'Ojcowski Park Narodowy' },
  { domain: 'lasy.gov.pl', label: 'Lasy Państwowe' },
  { domain: 'hzs.sk', label: 'Horská záchranná služba' },
  { domain: 'tanap.org', label: 'TANAP' },
  { domain: 'shmu.sk', label: 'SHMÚ' },
  { domain: 'horskasluzba.cz', label: 'Horská služba ČR' },
  { domain: 'krnap.cz', label: 'KRNAP' },
  { domain: 'chmi.cz', label: 'ČHMÚ' },
];

export const MOUNTAIN_INDUSTRY_DOMAINS: readonly string[] = MOUNTAIN_INDUSTRY_SOURCES.map(
  (source) => source.domain,
);

export function industrySourceLabel(url: string): string | undefined {
  const host = hostnameOf(url);
  if (!host) {
    return undefined;
  }
  let best: { domain: string; label: string } | undefined;
  for (const source of MOUNTAIN_INDUSTRY_SOURCES) {
    if (host === source.domain || host.endsWith(`.${source.domain}`)) {
      if (!best || source.domain.length > best.domain.length) {
        best = source;
      }
    }
  }
  return best?.label;
}

export function isMountainIndustryUrl(url: string): boolean {
  return industrySourceLabel(url) !== undefined;
}

/** Źródło wzorca bez flagi — wołający składa `new RegExp(..., 'gi')`, żeby nie dzielić lastIndex. */
export function mountainIndustryUrlSource(): string {
  const body = [...MOUNTAIN_INDUSTRY_SOURCES]
    .map((source) => source.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((left, right) => right.length - left.length)
    .join('|');
  return `https:\\/\\/(?:[a-z0-9-]+\\.)*(?:${body})(?![a-z0-9.-])(?::\\d+)?(?:\\/[^\\s<>"')\\]]*)?`;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
