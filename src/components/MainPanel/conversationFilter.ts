import type { ConversationItem } from '../../services/interfaces/IClient';
import type { DisplayMode } from '../../stores/settingsStore';

/**
 * Returns true if the item should be visible under the current display-mode filters.
 * Error and system items are always shown.
 */
export function shouldShowItem(
  item: ConversationItem,
  speakerMode: DisplayMode,
  participantMode: DisplayMode,
): boolean {
  if (item.type === 'error' || item.role === 'system') return true;
  // Non-message rows (function_call, function_call_output, etc.) aren't
  // source-vs-translation pairs, so they bypass the per-scope filter.
  if (item.type !== 'message') return true;

  const source = item.source ?? 'speaker';
  const mode = source === 'speaker' ? speakerMode : participantMode;

  if (mode === 'both') return true;
  if (mode === 'source') return item.role === 'user';
  if (mode === 'translation') return item.role === 'assistant';
  return true;
}

/**
 * hayamimi's second-pass keeps the raw first-pass group in the item list next
 * to the polished rewrite (`refined` items). The FINAL view — narrow panels,
 * the subtitle band, exports — hides raw items a rewrite has superseded.
 * Wide split views pair this with `supersededRawItems`, which returns exactly
 * the hidden raw items for the left-hand column.
 */
export function hideSupersededRaw<I extends ConversationItem>(items: readonly I[]): I[] {
  const superseded = supersededSegmentIds(items);
  return items.filter((item) =>
    !(item.refined !== true && item.segmentId != null && superseded.has(item.segmentId)),
  );
}

/** The raw first-pass items that a refined rewrite supersedes (split column). */
export function supersededRawItems<I extends ConversationItem>(items: readonly I[]): I[] {
  const superseded = supersededSegmentIds(items);
  return items.filter((item) =>
    !item.refined && item.segmentId != null && superseded.has(item.segmentId),
  );
}

/** Every first-pass item for the left side of the wide conversation view. */
export function rawFirstPassItems<I extends ConversationItem>(items: readonly I[]): I[] {
  return items.filter((item) => item.refined !== true);
}

/** Only Hayamimi's polished source rows and their polished translations. */
export function refinedPassItems<I extends ConversationItem>(items: readonly I[]): I[] {
  return items.filter((item) => item.refined === true);
}

function supersededSegmentIds<I extends ConversationItem>(items: readonly I[]): Set<number> {
  const ids = new Set<number>();
  for (const item of items) {
    if (item.refined) {
      for (const segmentId of item.refinedFor ?? []) ids.add(segmentId);
    }
  }
  return ids;
}
