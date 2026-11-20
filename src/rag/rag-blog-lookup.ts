export interface BlogPostRef {
  key: string;
  chunkId: string;
  title: string;
  url?: string;
  peakName: string;
}

export function normalizePeakName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase('pl-PL')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

export function peakNameFromBlogKey(key: string): string | undefined {
  const match = /^blog\/(.+)\.json$/i.exec(key.trim());
  if (!match) {
    return undefined;
  }
  const slugPath = match[1].trim();
  if (slugPath.length === 0) {
    return undefined;
  }
  const lastSegment = slugPath.split('/').filter(Boolean).pop() ?? '';
  const slug = decodeURIComponent(lastSegment).trim();
  if (slug.length === 0) {
    return undefined;
  }
  const normalized = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.charAt(0).toLocaleUpperCase('pl-PL') + normalized.slice(1);
}

export function peakNameFromBlogTitle(title: string): string | undefined {
  const segment = title.split(',')[0]?.trim();
  return segment && segment.length > 0 ? segment : undefined;
}

export function peakNamesForBlogEntry(key: string, title: string): string[] {
  const names = new Set<string>();
  const fromKey = peakNameFromBlogKey(key);
  if (fromKey) {
    names.add(fromKey);
  }
  const fromTitle = peakNameFromBlogTitle(title);
  if (fromTitle) {
    names.add(fromTitle);
  }
  return [...names];
}

export function peakNameFromBlogUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const lastSegment = new URL(trimmed).pathname.split('/').filter(Boolean).pop() ?? '';
    const slug = decodeURIComponent(lastSegment).trim();
    if (!slug) {
      return undefined;
    }
    const normalized = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return undefined;
    }
    return normalized.charAt(0).toLocaleUpperCase('pl-PL') + normalized.slice(1);
  } catch {
    return undefined;
  }
}

/** Pewne dopasowanie: tytuł, slug pliku albo ostatni segment URL to ten sam szczyt. */
export function blogIdentityMatchesPeak(
  peakName: string,
  candidate: { title?: string; url?: string; key?: string },
): boolean {
  const target = normalizePeakName(peakName);
  if (!target) {
    return false;
  }
  const labels: string[] = [];
  const title = candidate.title?.trim();
  if (title) {
    labels.push(title);
    const fromTitle = peakNameFromBlogTitle(title);
    if (fromTitle) {
      labels.push(fromTitle);
    }
  }
  if (candidate.key) {
    const fromKey = peakNameFromBlogKey(candidate.key);
    if (fromKey) {
      labels.push(fromKey);
    }
  }
  if (candidate.url) {
    const fromUrl = peakNameFromBlogUrl(candidate.url);
    if (fromUrl) {
      labels.push(fromUrl);
    }
  }
  return labels.some((label) => peakLabelMatches(label, target));
}

function peakLabelMatches(label: string, target: string): boolean {
  const normalized = normalizePeakName(label);
  if (!normalized) {
    return false;
  }
  if (normalized === target) {
    return true;
  }
  return (
    normalized.startsWith(`${target} `) ||
    normalized.startsWith(`${target},`) ||
    normalized.startsWith(`${target}-`) ||
    normalized.startsWith(`${target}—`)
  );
}