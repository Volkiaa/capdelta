/**
 * Character offsets where each line begins: 0, then one past every newline.
 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/**
 * Index of the last line start at or before offset, for offsets of 0 or more.
 */
export function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle] ?? 0;
    if (start <= offset) low = middle;
    else high = middle;
  }
  return low;
}
