export function expandPadding(
  content: string,
  marker: string,
  minimumBytes: number,
): string;

export function validateEntryLinks(links: [string, string][]): void;

export function rewriteAsciiUstarEntryModes(
  tarball: string,
  entryModes: Record<string, string>,
): Promise<void>;
