import type { ConversationItem } from '../../services/interfaces/IClient';

type IndexedItem<T extends ConversationItem> = {
  item: T;
  originalIndex: number;
  groupKey: string;
};

type GroupMeta = {
  firstIndex: number;
  firstTime: number;
};

function itemTime(item: ConversationItem): number {
  return Number.isFinite(item.createdAt) ? item.createdAt! : 0;
}

function pairGroupKey(item: ConversationItem, originalIndex: number): string {
  const canPair =
    item.type === 'message'
    && (item.role === 'user' || item.role === 'assistant')
    && Number.isFinite(item.segmentId);

  if (!canPair) return `item:${originalIndex}`;
  return `segment:${item.source ?? 'speaker'}:${item.segmentId}`;
}

function roleRank(item: ConversationItem): number {
  if (item.role === 'user') return 0;
  if (item.role === 'assistant') return 1;
  return 2;
}

/**
 * Keeps a committed transcript and its delayed translation adjacent.
 *
 * Local ASR clients attach the same segmentId to the source and translation,
 * but translation latency means their createdAt values can be seconds apart.
 * Items without a segmentId retain the existing chronological behaviour.
 */
export function orderConversationItems<T extends ConversationItem>(items: readonly T[]): T[] {
  const indexed: IndexedItem<T>[] = items.map((item, originalIndex) => ({
    item,
    originalIndex,
    groupKey: pairGroupKey(item, originalIndex),
  }));
  const groups = new Map<string, GroupMeta>();

  for (const entry of indexed) {
    const time = itemTime(entry.item);
    const existing = groups.get(entry.groupKey);
    if (!existing) {
      groups.set(entry.groupKey, { firstIndex: entry.originalIndex, firstTime: time });
      continue;
    }
    existing.firstIndex = Math.min(existing.firstIndex, entry.originalIndex);
    existing.firstTime = Math.min(existing.firstTime, time);
  }

  return indexed.sort((a, b) => {
    const aGroup = groups.get(a.groupKey)!;
    const bGroup = groups.get(b.groupKey)!;

    if (a.groupKey !== b.groupKey) {
      const timeDelta = aGroup.firstTime - bGroup.firstTime;
      if (timeDelta !== 0) return timeDelta;
      return aGroup.firstIndex - bGroup.firstIndex;
    }

    const rankDelta = roleRank(a.item) - roleRank(b.item);
    if (rankDelta !== 0) return rankDelta;

    const timeDelta = itemTime(a.item) - itemTime(b.item);
    if (timeDelta !== 0) return timeDelta;
    return a.originalIndex - b.originalIndex;
  }).map(({ item }) => item);
}
