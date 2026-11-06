/**
 * Fits text within a visual capacity by keeping the TAIL (newest spoken words)
 * and truncating the leading text with an ellipsis ('…').
 * Inspired by Cicada's fitTail algorithm.
 */
export function stringVisualLength(str: string): number {
  if (!str) return 0;
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // CJK and fullwidth characters count as 2 units; Latin/halfwidth count as 1 unit.
    len += code > 0x7f ? 2 : 1;
  }
  return len;
}

export function fitTail(text: string, maxUnits: number = 70): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (stringVisualLength(trimmed) <= maxUnits) {
    return trimmed;
  }

  const allowedUnits = Math.max(4, maxUnits - 2);
  let currentUnits = 0;
  let cutIndex = trimmed.length;

  for (let i = trimmed.length - 1; i >= 0; i--) {
    const code = trimmed.charCodeAt(i);
    const weight = code > 0x7f ? 2 : 1;
    if (currentUnits + weight > allowedUnits) {
      break;
    }
    currentUnits += weight;
    cutIndex = i;
  }

  let candidate = trimmed.slice(cutIndex);
  if (cutIndex > 0 && trimmed[cutIndex - 1] !== ' ' && candidate.includes(' ')) {
    const spaceIndex = candidate.indexOf(' ');
    if (spaceIndex > 0 && spaceIndex < 12) {
      candidate = candidate.slice(spaceIndex + 1);
    }
  }

  return '…' + candidate;
}
