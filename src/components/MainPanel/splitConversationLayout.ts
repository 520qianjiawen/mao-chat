export const MIN_SPLIT_PANEL_WIDTH = 840;
export const SPLIT_SCREEN_WIDTH_RATIO = 0.45;

/**
 * Split when the actual transcript panel occupies most of the available
 * screen while preserving roughly 400 px of useful width per column.
 */
export function shouldUseSplitConversationView(
  panelWidth: number,
  screenAvailableWidth: number,
  splitEligible: boolean,
): boolean {
  if (!splitEligible) return false;
  const responsiveWidth = Number.isFinite(screenAvailableWidth) && screenAvailableWidth > 0
    ? screenAvailableWidth * SPLIT_SCREEN_WIDTH_RATIO
    : MIN_SPLIT_PANEL_WIDTH;
  return panelWidth >= Math.max(MIN_SPLIT_PANEL_WIDTH, responsiveWidth);
}
