/** SenseVoice / Moonshine often invent filler when fed silence or music. */
const SILENCE_HALLUCINATIONS = new Set([
  'ご視聴ありがとうございました',
  'ご視聴ありがとう',
  '字幕視聴ありがとうございました',
  'thanks for watching',
  'thank you for watching',
  'thank you',
  'thanks',
  'music',
  'applause',
]);

const FILLER_ONLY = /^(啊+|嗯+|呃+|额+|唔+|えー+|えっと|あの+|うん+|はい+|哦+|喔+|哇+)$/u;
const PUNCT_ONLY = /^[。．.、，,！!？?…ー～〜・\s]+$/u;

export function cleanOfflineAsrText(
  raw: string | undefined | null,
  options?: { dropFillers?: boolean },
): string {
  const cleaned = String(raw || '')
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/\[(?:music|applause|laughter|silence|inaudible)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (PUNCT_ONLY.test(cleaned)) return '';
  if (SILENCE_HALLUCINATIONS.has(cleaned.toLowerCase())) return '';
  if (options?.dropFillers && FILLER_ONLY.test(cleaned)) return '';
  return cleaned;
}
