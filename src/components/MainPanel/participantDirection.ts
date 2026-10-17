import type { AudioMode } from '../../stores/audioStore';
import { Provider } from '../../types/Provider';

/**
 * Whether the captured (Others) channel keeps Settings' source → target pair.
 *
 * You: mic only. Source = my language, target = translate into.
 * Others: computer/tab only. Source = their language, target = translate into.
 * Both: mic source → target, computer/tab target → source (mutual).
 */
export function shouldKeepCapturedAudioDirection(
  _provider: Provider,
  mode: AudioMode,
  _environment: { electron: boolean; extension: boolean },
): boolean {
  return mode === 'participant';
}
