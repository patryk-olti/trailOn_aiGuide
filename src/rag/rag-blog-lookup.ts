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
  const slug = match[1].trim();
  if (slug.length === 0) {
    return undefined;
  }
  return slug.charAt(0).toLocaleUpperCase('pl-PL') + slug.slice(1);
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