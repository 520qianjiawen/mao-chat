// Background script for MAO Chat browser extension
// This script handles configuration storage

/* global chrome */

// Default configuration values
const DEFAULT_CONFIG = {
  openAIApiKey: '',
  model: 'gpt-realtime-mini',
  voice: 'alloy',
  systemInstructions: '',
  temperature: 0.8,
  maxTokens: 'inf',
  turnDetectionMode: 'Normal',
  silenceDuration: 0.5,
  prefixPadding: 0.1,
  threshold: 0.5,
  semanticEagerness: 'Medium',
  noiseReduction: 'None',
  transcriptModel: 'whisper-1'
};

// Tab audio and the subtitle overlay work on ordinary web pages. Browser
// internal pages cannot be captured or scripted, so keep the action popup
// there instead of offering a start flow that must fail.
function isCapturableUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

async function configureCapturableTab(tabId, rawUrl) {
  if (!isCapturableUrl(rawUrl)) return false;
  const url = new URL(rawUrl);
  await chrome.sidePanel.setOptions({
    tabId,
    path: `fullpage.html?tabId=${tabId}&trigger=action_click&site=${encodeURIComponent(url.hostname)}`,
    enabled: true,
  });
  // Clearing the popup makes chrome.action.onClicked fire. That user gesture
  // grants activeTab, which is required by both tabCapture and the one-page
  // subtitle content-script injection.
  await chrome.action.setPopup({ tabId, popup: '' });
  return true;
}

// Track which tabs have the side panel open
const tabsWithSidePanelOpen = new Set();

// Track active tab audio captures
const activeTabCaptures = new Map(); // tabId -> { streamId, active }

// Chrome destroys a side-panel document when the panel closes. Keep the live
// ASR/translation engine in an offscreen extension document so the user can
// reclaim the full browser width while the in-page subtitle overlay continues.
const SUBTITLE_SESSION_HOST_PATH = 'session-host.html';
let subtitleHostReady = false;
let subtitleHostTabId = null;
let subtitleHostPhase = 'idle';
const subtitleHostReadyWaiters = new Set();

function notifySubtitleHostReady() {
  subtitleHostReady = true;
  for (const resolve of subtitleHostReadyWaiters) resolve();
  subtitleHostReadyWaiters.clear();
}

function waitForSubtitleHostReady(timeoutMs = 15000) {
  if (subtitleHostReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      subtitleHostReadyWaiters.delete(onReady);
      resolve();
    };
    const timer = setTimeout(() => {
      subtitleHostReadyWaiters.delete(onReady);
      reject(new Error('Hidden subtitle host did not become ready'));
    }, timeoutMs);
    subtitleHostReadyWaiters.add(onReady);
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function ensureSubtitleSessionHost() {
  if (!chrome.offscreen?.hasDocument || !chrome.offscreen?.createDocument) {
    throw new Error('This Chrome version does not support hidden subtitle sessions');
  }

  const alreadyOpen = await chrome.offscreen.hasDocument();
  if (!alreadyOpen) {
    subtitleHostReady = false;
    await chrome.offscreen.createDocument({
      url: SUBTITLE_SESSION_HOST_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Keep tab-audio transcription and translation running after the side panel closes',
    });
  } else if (!subtitleHostReady) {
    // The service worker can restart while the offscreen document stays alive.
    // Recover its ready state instead of waiting for an event that already ran.
    try {
      const pong = await sendRuntimeMessage({ type: 'SUBTITLE_SESSION_HOST_PING' });
      if (pong?.success) notifySubtitleHostReady();
    } catch {
      // The document may still be booting; its READY event will resolve us.
    }
  }

  await waitForSubtitleHostReady();
}

async function closeSubtitleSidePanel(tabId) {
  if (typeof chrome.sidePanel?.close !== 'function') {
    const error = new Error('Closing the side panel requires Chrome 141 or newer');
    error.code = 'SIDE_PANEL_CLOSE_UNSUPPORTED';
    throw error;
  }
  await chrome.sidePanel.close({ tabId });
  tabsWithSidePanelOpen.delete(tabId);
}

async function shutdownSubtitleSessionHost() {
  subtitleHostReady = false;
  subtitleHostPhase = 'idle';
  subtitleHostTabId = null;
  try {
    if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (error) {
    console.warn('[Sokuji] [Background] Failed to close subtitle host:', error);
  }
}

async function stopSubtitleSessionHost() {
  try {
    await sendRuntimeMessage({ type: 'STOP_SUBTITLE_SESSION_HOST' });
  } catch (error) {
    console.warn('[Sokuji] [Background] Failed to stop subtitle host cleanly:', error);
    await shutdownSubtitleSessionHost();
  }
}

async function prepareSubtitleTakeover() {
  if (typeof chrome.sidePanel?.close !== 'function') {
    return {
      success: false,
      code: 'SIDE_PANEL_CLOSE_UNSUPPORTED',
      error: 'Closing the side panel requires Chrome 141 or newer',
    };
  }

  const tabId = await resolveCaptureTabId();
  if (!tabId) {
    return { success: false, error: 'No capturable video tab found' };
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'subtitle:probe' });
  } catch (error) {
    return {
      success: false,
      code: 'CONTENT_SCRIPT_UNAVAILABLE',
      error: error?.message || 'Refresh the video tab and try again',
    };
  }

  subtitleHostTabId = tabId;
  subtitleHostPhase = 'preparing';
  try {
    await ensureSubtitleSessionHost();
    return { success: true, tabId };
  } catch (error) {
    await shutdownSubtitleSessionHost();
    return {
      success: false,
      code: 'SESSION_HOST_UNAVAILABLE',
      error: error?.message || String(error),
    };
  }
}

async function launchSubtitleHostAfterPanelClose(tabId) {
  try {
    // The side-panel document owns the old MediaStream. Chrome can keep that
    // ownership alive until the document itself is destroyed even after its
    // tracks have received stop(), so close it before the offscreen host asks
    // for a replacement capture.
    subtitleHostPhase = 'closing-side-panel';
    await closeSubtitleSidePanel(tabId);
    await waitForTabCaptureRelease(tabId, 10000);

    subtitleHostPhase = 'starting';
    const response = await sendRuntimeMessage({
      type: 'START_SUBTITLE_SESSION_HOST',
      tabId,
    });
    if (!response?.success) {
      throw new Error(response?.error || 'Hidden subtitle host failed to start');
    }
  } catch (error) {
    console.error('[Sokuji] [Background] Subtitle takeover launch failed:', error);
    subtitleHostPhase = 'error';
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'subtitle:exit' });
    } catch {
      // The overlay may not have mounted yet.
    }
    await shutdownSubtitleSessionHost();
  }
}

async function startSubtitleTakeover() {
  if (!subtitleHostReady || !subtitleHostTabId) {
    return { success: false, error: 'Hidden subtitle host is not ready' };
  }
  const tabId = subtitleHostTabId;

  // Let the side-panel caller receive success before the next task closes and
  // destroys its document. The background worker owns the remainder of the
  // handoff and survives that close.
  setTimeout(() => {
    void launchSubtitleHostAfterPanelClose(tabId);
  }, 0);
  return { success: true, tabId };
}

/**
 * Restore the browser side panel when the user closes the in-page subtitle
 * overlay. Keep `chrome.sidePanel.open()` as the first asynchronous browser
 * operation: Chrome only permits it while handling the user's click. Session
 * shutdown continues independently through the existing subtitle:user-exit
 * port message and SUBTITLE_SESSION_HOST_FINISHED lifecycle.
 */
function restoreSidePanelAfterSubtitle(senderTabId) {
  const tabId = Number(senderTabId) || subtitleHostTabId;
  if (!tabId) {
    return Promise.resolve({ success: false, error: 'Subtitle tab is unavailable' });
  }

  try {
    const openResult = chrome.sidePanel.open({ tabId });
    return Promise.resolve(openResult).then(() => {
      tabsWithSidePanelOpen.add(tabId);
      return { success: true, tabId };
    }).catch((error) => ({
      success: false,
      error: error?.message || String(error),
    }));
  } catch (error) {
    return Promise.resolve({
      success: false,
      error: error?.message || String(error),
    });
  }
}

// Store PostHog distinct_id received from frontend
let currentDistinctId = null;

// Function to get stored distinct_id
async function getStoredDistinctId() {
  try {
    const result = await chrome.storage.local.get('posthog_distinct_id');
    return result.posthog_distinct_id || null;
  } catch (error) {
    console.error('[Sokuji] [Background] Error getting stored distinct_id:', error);
    return null;
  }
}

// Function to store distinct_id
async function storeDistinctId(distinctId) {
  try {
    await chrome.storage.local.set({ posthog_distinct_id: distinctId });
    currentDistinctId = distinctId;
    console.debug('[Sokuji] [Background] Stored distinct_id');
    return true;
  } catch (error) {
    console.error('[Sokuji] [Background] Error storing distinct_id:', error);
    return false;
  }
}

// Chrome opens this URL after uninstall. Clear it so MAO Chat does not send
// people to the upstream Sokuji feedback form.
async function updateUninstallURL(_distinctId = null) {
  try {
    if (chrome.runtime.setUninstallURL) {
      chrome.runtime.setUninstallURL('');
    }
    return true;
  } catch (error) {
    console.error('[MAO Chat] [Background] Error clearing uninstall URL:', error);
    return false;
  }
}

// Initialize configuration in storage if not already set
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const result = await chrome.storage.local.get('config');
    if (!result.config) {
      await chrome.storage.local.set({ config: DEFAULT_CONFIG });
      console.debug('[Sokuji] [Background] Default configuration initialized');
    }

    await updateUninstallURL();
  } catch (error) {
    console.error('[Sokuji] [Background] Error initializing configuration:', error);
  }
});

// Side panel activation strategy:
// For video, live-stream, and meeting pages, we capture tab audio via
// chrome.tabCapture, which requires the `activeTab` permission. activeTab is
// only granted when the user explicitly invokes the extension on the current
// page — specifically, when chrome.action.onClicked fires.
//
// `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` causes
// Chrome to open the side panel DIRECTLY on action click without firing
// onClicked, so activeTab is never granted and tabCapture fails with
// "Extension has not been invoked for the current page".
//
// Fix: disable the popup per-tab on ordinary web pages (so onClicked fires), and
// manually open the side panel via chrome.sidePanel.open({ tabId }) inside the
// onClicked handler. Browser-internal pages keep the informational popup.

// Listen for tab URL updates to manage side panel visibility.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only process when URL changes or when the tab is complete
  if (!changeInfo.url && changeInfo.status !== 'complete') return;

  try {
    if (await configureCapturableTab(tabId, tab.url)) {
      console.debug('[Sokuji] [Background] Enabled side panel for capturable tab:', tab.url);
    } else {
      // Disable side panel for this tab and restore the popup
      await chrome.sidePanel.setOptions({
        tabId: tabId,
        enabled: false,
      });
      await chrome.action.setPopup({ tabId: tabId, popup: 'popup.html' });
      if (tabsWithSidePanelOpen.has(tabId)) {
        tabsWithSidePanelOpen.delete(tabId);
        console.debug('[Sokuji] [Background] Removed tab from side panel tracking due to URL change:', tabId);
      }
    }
  } catch (error) {
    console.error('[Sokuji] [Background] Error updating side panel for tab:', error);
  }
});

// Listen for tab switching events to update side panel visibility
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tabId = activeInfo.tabId;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;

    if (await configureCapturableTab(tabId, tab.url)) {
      console.debug('[Sokuji] [Background] Maintaining side panel for capturable tab:', tab.url);
    } else {
      // Reset the GLOBAL default to disabled so any currently-open side panel
      // actually closes when the user switches to an unsupported tab. Per-tab
      // `enabled: false` alone does not reliably hide a panel that is already
      // visible in the window.
      await chrome.sidePanel.setOptions({
        enabled: false,
      });
      await chrome.action.setPopup({ tabId: tabId, popup: 'popup.html' });
    }
  } catch (error) {
    console.error('[Sokuji] [Background] Error updating side panel for switched tab:', error);
  }
});

// On icon click, open the side panel and inject the subtitle host into exactly
// the page the user invoked. The script is idempotent, so known meeting sites
// where it was declared in manifest.json are safe too.
//
// IMPORTANT: `chrome.sidePanel.open()` may only be called in response to
// a user gesture. Any `await` before it drops the gesture and causes
// "may only be called in response to a user gesture". That's why this
// handler is a plain non-async function — setOptions has already been
// called in onUpdated/onActivated, so the tab-specific side panel path
// is already configured by the time the user clicks the action.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id || !tab.url) return;

  if (!isCapturableUrl(tab.url)) return;
  const url = new URL(tab.url);

  // Start both privileged operations synchronously while the user gesture is
  // still live; await them only after both calls have been issued.
  const panelPromise = chrome.sidePanel.open({ tabId: tab.id });
  const injectionPromise = chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['subtitle-overlay-content.js'],
  });

  Promise.all([panelPromise, injectionPromise]).then(() => {
    tabsWithSidePanelOpen.add(tab.id);
    console.debug('[Sokuji] [Background] Opened side panel on action click for:', url.hostname);
  }).catch((error) => {
    console.error('[Sokuji] [Background] Failed to open side panel or inject subtitles:', error);
  });
});

// Listen for tab closing to clean up tracking
chrome.tabs.onRemoved.addListener((tabId) => {
  // Remove the tab from tracking when it's closed
  if (tabsWithSidePanelOpen.has(tabId)) {
    tabsWithSidePanelOpen.delete(tabId);
    console.debug('[Sokuji] [Background] Removed closed tab from side panel tracking:', tabId);
  }

  // Clean up any active tab audio captures
  if (activeTabCaptures.has(tabId)) {
    activeTabCaptures.delete(tabId);
    console.debug('[Sokuji] [Background] Cleaned up tab capture for closed tab:', tabId);
  }

  if (tabId === subtitleHostTabId) {
    void stopSubtitleSessionHost();
  }
});

// ─── Volcengine AST2 declarativeNetRequest header injection ───────────────
// Browser WebSocket API cannot send custom headers. We use declarativeNetRequest
// dynamic rules to inject auth headers into the WebSocket upgrade request.
const VOLCENGINE_DNR_RULE_ID_BASE = 2000;
const VOLCENGINE_WS_HOST = 'openspeech.bytedance.com';

let dnrUpdatePromise = Promise.resolve();

async function volcengineSetDNRHeaders(credentials) {
  dnrUpdatePromise = dnrUpdatePromise.then(async () => {
    const { appKey, accessKey, resourceId, connectId } = credentials;

    const headers = [
      { header: 'X-Api-App-Key', value: appKey },
      { header: 'X-Api-Access-Key', value: accessKey },
      { header: 'X-Api-Resource-Id', value: resourceId },
      { header: 'X-Api-Connect-Id', value: connectId },
    ];

    const rules = headers.map((h, i) => ({
      id: VOLCENGINE_DNR_RULE_ID_BASE + i,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: h.header, operation: 'set', value: h.value },
        ],
      },
      condition: {
        urlFilter: `||${VOLCENGINE_WS_HOST}`,
        resourceTypes: ['websocket'],
      },
    }));

    // Remove any existing Volcengine rules first
    const existingRuleIds = (await chrome.declarativeNetRequest.getDynamicRules())
      .filter(r => r.id >= VOLCENGINE_DNR_RULE_ID_BASE && r.id < VOLCENGINE_DNR_RULE_ID_BASE + 10)
      .map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRuleIds,
      addRules: rules,
    });

    console.debug('[Sokuji] [Background] Volcengine AST2 DNR rules registered:', rules.length);
  });
  return dnrUpdatePromise;
}

async function volgengineClearDNRHeaders() {
  dnrUpdatePromise = dnrUpdatePromise.then(async () => {
    const existingRuleIds = (await chrome.declarativeNetRequest.getDynamicRules())
      .filter(r => r.id >= VOLCENGINE_DNR_RULE_ID_BASE && r.id < VOLCENGINE_DNR_RULE_ID_BASE + 10)
      .map(r => r.id);

    if (existingRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRuleIds,
      });
      console.debug('[Sokuji] [Background] Volcengine AST2 DNR rules cleared');
    }
  });
  return dnrUpdatePromise;
}

// ─── Edge TTS declarativeNetRequest header injection ──────────────────────
// Edge TTS requires specific headers to connect to Bing's TTS WebSocket endpoint.
// We use declarativeNetRequest to inject these headers for the extension context.
const EDGE_TTS_DNR_RULE_ID_BASE = 3000;
const EDGE_TTS_WS_HOST = 'speech.platform.bing.com';
const EDGE_TTS_CHROMIUM_VERSION = '143.0.3650.75';
const EDGE_TTS_CHROMIUM_MAJOR = EDGE_TTS_CHROMIUM_VERSION.split('.')[0];

const BING_TRANSLATOR_DNR_RULE_ID = 9301;
const BING_TRANSLATOR_HOST = 'www.bing.com';
const BING_TRANSLATOR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
  + `${EDGE_TTS_CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_TTS_CHROMIUM_MAJOR}.0.0.0`;

async function edgeTtsSetDNRHeaders() {
  // Bing TTS WebSocket requires an Edge browser User-Agent to accept the
  // connection (Chrome UA returns 403). Browser WebSocket API cannot set
  // custom headers, so we inject it via declarativeNetRequest.
  //
  // IMPORTANT: For DNR to actually modify WebSocket upgrade headers, the
  // host_permissions must include `wss://` explicitly — `*://` covers
  // http/https but NOT ws/wss, and Chrome silently ignores DNR rules that
  // target hosts outside the permission scope.
  const rules = [
    {
      id: EDGE_TTS_DNR_RULE_ID_BASE,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'User-Agent', operation: 'set', value: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_TTS_CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_TTS_CHROMIUM_MAJOR}.0.0.0` },
        ],
      },
      condition: {
        urlFilter: `||${EDGE_TTS_WS_HOST}`,
        resourceTypes: ['websocket'],
      },
    },
  ];

  // Remove any existing Edge TTS rules first
  const existingRuleIds = (await chrome.declarativeNetRequest.getDynamicRules())
    .filter(r => r.id >= EDGE_TTS_DNR_RULE_ID_BASE && r.id < EDGE_TTS_DNR_RULE_ID_BASE + 10)
    .map(r => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRuleIds,
    addRules: rules,
  });

  console.debug('[Sokuji] [Background] Edge TTS DNR rules registered');
}

async function edgeTtsClearDNRHeaders() {
  const existingRuleIds = (await chrome.declarativeNetRequest.getDynamicRules())
    .filter(r => r.id >= EDGE_TTS_DNR_RULE_ID_BASE && r.id < EDGE_TTS_DNR_RULE_ID_BASE + 10)
    .map(r => r.id);

  if (existingRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRuleIds,
    });
    console.debug('[Sokuji] [Background] Edge TTS DNR rules cleared');
  }
}

// ─── Bing Translator declarativeNetRequest header injection ───────────────────
// Bing Translator's /ttranslatev3 endpoint requires browser-like headers or it
// returns 403/empty responses. We inject them via declarativeNetRequest so the
// extension's fetch requests from Workers are treated as legitimate browser traffic.
async function bingTranslatorSetDNRHeaders() {
  const rules = [
    {
      id: BING_TRANSLATOR_DNR_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'User-Agent', operation: 'set', value: BING_TRANSLATOR_UA },
          { header: 'Origin', operation: 'set', value: 'https://www.bing.com' },
          { header: 'Referer', operation: 'set', value: 'https://www.bing.com/translator' },
          { header: 'Accept-Language', operation: 'set', value: 'en-US,en;q=0.9' },
        ],
      },
      condition: {
        urlFilter: `||${BING_TRANSLATOR_HOST}`,
        resourceTypes: ['xmlhttprequest'],
        // Only rewrite requests the extension itself issues (the Bing worker
        // runs in an extension-page context). Prevents interference with the
        // user's own bing.com tabs, which also issue xmlhttprequest.
        initiatorDomains: [chrome.runtime.id],
      },
    },
  ];

  const existingRuleIds = (await chrome.declarativeNetRequest.getDynamicRules())
    .filter(r => r.id === BING_TRANSLATOR_DNR_RULE_ID)
    .map(r => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRuleIds,
    addRules: rules,
  });

  console.debug('[Sokuji] [Background] Bing Translator DNR rules registered');
}

async function bingTranslatorClearDNRHeaders() {
  const existingRuleIds = (await chrome.declarativeNetRequest.getDynamicRules())
    .filter(r => r.id === BING_TRANSLATOR_DNR_RULE_ID)
    .map(r => r.id);

  if (existingRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRuleIds,
    });
    console.debug('[Sokuji] [Background] Bing Translator DNR rules cleared');
  }
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PREPARE_SUBTITLE_TAKEOVER') {
    prepareSubtitleTakeover().then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message.type === 'START_SUBTITLE_TAKEOVER') {
    startSubtitleTakeover().then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message.type === 'SUBTITLE_SESSION_HOST_BOOTSTRAP') {
    chrome.storage.sync.get(null).then((settings) => {
      sendResponse({ success: true, settings });
    }).catch((error) => {
      sendResponse({ success: false, settings: {}, error: error?.message || String(error) });
    });
    return true;
  }

  if (message.type === 'SUBTITLE_SESSION_HOST_READY') {
    notifySubtitleHostReady();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'SUBTITLE_SESSION_HOST_ACTIVE') {
    subtitleHostPhase = 'active';
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'SUBTITLE_SESSION_HOST_ERROR') {
    console.error('[Sokuji] [Background] Subtitle host error:', message.error);
    subtitleHostPhase = 'error';
    if (subtitleHostTabId) {
      chrome.tabs.sendMessage(subtitleHostTabId, { type: 'subtitle:exit' }).catch(() => {});
    }
    void shutdownSubtitleSessionHost();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'SUBTITLE_SESSION_HOST_FINISHED') {
    void shutdownSubtitleSessionHost();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'SUBTITLE_TAB_MESSAGE_PROXY') {
    const tabId = Number(message.tabId);
    const hostUrl = chrome.runtime.getURL(SUBTITLE_SESSION_HOST_PATH);
    if (!tabId || sender.url !== hostUrl) {
      sendResponse({ success: false, error: 'Rejected subtitle tab proxy request' });
      return false;
    }
    chrome.tabs.sendMessage(tabId, message.message).then((response) => {
      sendResponse({ success: true, response });
    }).catch((error) => {
      sendResponse({
        success: false,
        code: 'CONTENT_SCRIPT_UNAVAILABLE',
        error: error?.message || String(error),
      });
    });
    return true;
  }

  if (message.type === 'RESTORE_SIDE_PANEL_AFTER_SUBTITLE') {
    restoreSidePanelAfterSubtitle(sender.tab?.id).then(sendResponse);
    return true;
  }

  if (message.type === 'GET_CONFIG') {
    handleGetConfig(message.key, message.defaultValue).then(sendResponse);
    return true; // Indicates async response
  }

  if (message.type === 'SET_CONFIG') {
    handleSetConfig(message.key, message.value).then(sendResponse);
    return true; // Indicates async response
  }

  if (message.type === 'OPEN_SIDE_PANEL') {
    handleOpenSidePanel(message.tabId).then(sendResponse);
    return true; // Indicates async response
  }

  if (message.type === 'UPDATE_UNINSTALL_URL') {
    // Handle distinct_id from frontend
    const distinctId = message.distinct_id;
    if (distinctId) {
      // Store the distinct_id and update uninstall URL
      storeDistinctId(distinctId).then(() => {
        return updateUninstallURL(distinctId);
      }).then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        console.error('[Sokuji] [Background] Error handling distinct_id update:', error);
        sendResponse({ success: false, error: error.message });
      });
    } else {
      // Just update with existing distinct_id
      updateUninstallURL().then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        console.error('[Sokuji] [Background] Error updating uninstall URL:', error);
        sendResponse({ success: false, error: error.message });
      });
    }
    return true; // Indicates async response
  }

  // Handle Volcengine AST2 DNR header injection
  if (message.type === 'VOLCENGINE_AST2_SET_HEADERS') {
    volcengineSetDNRHeaders(message.credentials)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Sokuji] [Background] Failed to set Volcengine DNR headers:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'VOLCENGINE_AST2_CLEAR_HEADERS') {
    volgengineClearDNRHeaders()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Sokuji] [Background] Failed to clear Volcengine DNR headers:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // Handle Edge TTS DNR header injection
  if (message.type === 'EDGE_TTS_SET_HEADERS') {
    edgeTtsSetDNRHeaders()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Sokuji] [Background] Failed to set Edge TTS DNR headers:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'EDGE_TTS_CLEAR_HEADERS') {
    edgeTtsClearDNRHeaders()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Sokuji] [Background] Failed to clear Edge TTS DNR headers:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // Handle Bing Translator DNR header injection
  if (message.type === 'BING_TRANSLATOR_SET_HEADERS') {
    bingTranslatorSetDNRHeaders()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Sokuji] [Background] Failed to set Bing Translator DNR headers:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'BING_TRANSLATOR_CLEAR_HEADERS') {
    bingTranslatorClearDNRHeaders()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Sokuji] [Background] Failed to clear Bing Translator DNR headers:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // Handle START_TAB_CAPTURE message from side panel
  if (message.type === 'START_TAB_CAPTURE') {
    handleStartTabCapture(message.tabId || sender.tab?.id).then(sendResponse);
    return true; // Indicates async response
  }

  // Handle STOP_TAB_CAPTURE message from side panel
  if (message.type === 'STOP_TAB_CAPTURE') {
    handleStopTabCapture(message.tabId || sender.tab?.id).then(sendResponse);
    return true; // Indicates async response
  }

  // Side panel opened without ?tabId= (stale default_path) — resolve a capturable tab.
  if (message.type === 'RESOLVE_CAPTURE_TAB') {
    resolveCaptureTabId().then((tabId) => {
      if (tabId) sendResponse({ success: true, tabId });
      else sendResponse({ success: false, error: 'No capturable tab found' });
    }).catch((error) => {
      sendResponse({ success: false, error: error?.message || String(error) });
    });
    return true;
  }

  // List capturable browser tabs for the extension Tab picker UI.
  if (message.type === 'LIST_BROWSER_TABS') {
    handleListBrowserTabs().then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error?.message || String(error), tabs: [] });
    });
    return true;
  }
});

// Get configuration value
async function handleGetConfig(key, defaultValue) {
  try {
    const result = await chrome.storage.local.get('config');
    const config = result.config || DEFAULT_CONFIG;

    if (key) {
      return { success: true, value: config[key] !== undefined ? config[key] : defaultValue };
    } else {
      return { success: true, value: config };
    }
  } catch (error) {
    console.error('[Sokuji] [Background] Error getting config:', error);
    return { success: false, error: error.message, value: defaultValue };
  }
}

// Set configuration value
async function handleSetConfig(key, value) {
  try {
    const result = await chrome.storage.local.get('config');
    const config = result.config || DEFAULT_CONFIG;

    // Update the config
    config[key] = value;

    // Save back to storage
    await chrome.storage.local.set({ config });

    return { success: true };
  } catch (error) {
    console.error('[Sokuji] [Background] Error setting config:', error);
    return { success: false, error: error.message };
  }
}

// Handle opening side panel from popup
async function handleOpenSidePanel(tabId) {
  try {
    await chrome.sidePanel.open({ tabId: tabId });
    tabsWithSidePanelOpen.add(tabId);
    console.debug('[Sokuji] [Background] Opened side panel for tab:', tabId);
    return { success: true };
  } catch (error) {
    console.error('[Sokuji] [Background] Error opening side panel:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Enumerate http(s) tabs the user can choose as the tab-audio capture target.
 * Audible tabs sort first so "3 tabs playing sound" is easy to pick from.
 */
async function handleListBrowserTabs() {
  try {
    const all = await chrome.tabs.query({});
    const tabs = all
      .filter((t) => t.id && isCapturableUrl(t.url))
      .map((t) => ({
        id: t.id,
        title: (t.title || t.url || `Tab ${t.id}`).trim(),
        url: t.url || '',
        audible: !!t.audible,
        active: !!t.active,
        windowId: t.windowId,
        favIconUrl: t.favIconUrl || '',
      }))
      .sort((a, b) => {
        // Playing → active → title
        if (a.audible !== b.audible) return a.audible ? -1 : 1;
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
    return { success: true, tabs };
  } catch (error) {
    console.error('[Sokuji] [Background] LIST_BROWSER_TABS failed:', error);
    return { success: false, error: error?.message || String(error), tabs: [] };
  }
}

/**
 * Pick a tab the side panel should capture when fullpage.html has no ?tabId=.
 * Prefer the last-focused http(s) tab; skip chrome:// and extension pages.
 */
async function resolveCaptureTabId() {
  try {
    if (subtitleHostTabId && subtitleHostPhase !== 'idle') return subtitleHostTabId;

    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focused?.id && isCapturableUrl(focused.url)) return focused.id;

    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id && isCapturableUrl(active.url)) return active.id;

    const all = await chrome.tabs.query({ lastFocusedWindow: true });
    const hit = all.find((t) => t.id && isCapturableUrl(t.url));
    return hit?.id ?? null;
  } catch (error) {
    console.error('[Sokuji] [Background] resolveCaptureTabId failed:', error);
    return null;
  }
}

/**
 * Chrome rejects getMediaStreamId while the target tab still owns a pending
 * or active capture. Session state flips to inactive before MediaStream track
 * shutdown finishes, so synchronize against Chrome's actual capture registry
 * before minting the next one.
 *
 * @returns {Promise<boolean>} true if the tab is free, false if still held
 *   after timeout (caller may still try / retry getMediaStreamId).
 */
async function waitForTabCaptureRelease(tabId, timeoutMs = 10_000) {
  if (typeof chrome.tabCapture?.getCapturedTabs !== 'function') return true;

  const deadline = Date.now() + timeoutMs;
  let delayMs = 50;
  while (Date.now() < deadline) {
    try {
      const capturedTabs = await chrome.tabCapture.getCapturedTabs();
      const existing = capturedTabs.find((capture) => capture.tabId === tabId);
      if (!existing) return true;
      console.info(
        '[Sokuji] [Background] Tab still captured (status=%s); waiting for release…',
        existing.status ?? 'unknown',
      );
    } catch (error) {
      // getCapturedTabs can fail on some Chromium builds; don't block start.
      console.warn('[Sokuji] [Background] getCapturedTabs failed:', error);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 1.5, 400);
  }

  console.warn(
    '[Sokuji] [Background] Tab capture still listed after %dms; will retry getMediaStreamId anyway',
    timeoutMs,
  );
  return false;
}

function isTransientTabCaptureError(message) {
  const lower = String(message || '').toLowerCase();
  return (
    lower.includes('still closing')
    || lower.includes('pending')
    || lower.includes('active capture')
    || lower.includes('already being captured')
    || lower.includes('cannot capture')
    || lower.includes('stream id')
    || lower.includes('not available')
  );
}

function requestMediaStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(
      { targetTabId: tabId },
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!id) {
          reject(new Error('Failed to get stream ID'));
        } else {
          resolve(id);
        }
      },
    );
  });
}

// Start tab audio capture and return streamId
async function handleStartTabCapture(tabId) {
  try {
    console.info('[Sokuji] [Background] Starting tab capture for tab:', tabId);

    // Validate / resolve tabId
    if (!tabId) {
      tabId = await resolveCaptureTabId();
    }
    if (!tabId) {
      return {
        success: false,
        error: 'Tab ID is required. Click the MAO Chat icon on the video tab, then Start.',
      };
    }

    // NEVER reuse a previous streamId. Chrome issues single-use tokens that
    // expire within seconds if unused, and become invalid once getUserMedia
    // consumes them. Returning a cached id causes intermittent
    // "Failed to begin tab audio capture" on Start/retry.
    if (activeTabCaptures.has(tabId)) {
      console.info('[Sokuji] [Background] Clearing stale capture entry before minting a new streamId');
      activeTabCaptures.delete(tabId);
    }

    // Verify the tab exists and is capturable
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      console.error('[Sokuji] [Background] Tab not found:', tabId);
      return { success: false, error: 'Tab not found' };
    }
    if (!isCapturableUrl(tab?.url)) {
      return {
        success: false,
        error: 'This page cannot be captured (browser internal pages are blocked). Open a normal https video or meeting tab.',
      };
    }

    // Wait for any previous capture to drop out of Chrome's registry, then
    // mint a streamId with retries. Rapid Start/Stop/Subtitle handoff often
    // leaves a short tail where getCapturedTabs still lists the tab even
    // after tracks were stopped — hard-failing there is worse than retrying.
    const maxAttempts = 8;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const released = await waitForTabCaptureRelease(tabId, attempt === 1 ? 2500 : 1500);
      try {
        console.info(
          '[Sokuji] [Background] Calling chrome.tabCapture.getMediaStreamId for tabId=%s attempt=%s released=%s',
          tabId,
          attempt,
          released,
        );
        const streamId = await requestMediaStreamId(tabId);

        activeTabCaptures.set(tabId, { streamId, active: true, mintedAt: Date.now() });
        console.info('[Sokuji] [Background] Tab capture started successfully, streamId:', streamId);
        return { success: true, streamId, tabId };
      } catch (error) {
        lastError = error;
        const raw = error?.message || String(error);
        console.warn(
          '[Sokuji] [Background] getMediaStreamId attempt %s/%s failed: %s',
          attempt,
          maxAttempts,
          raw,
        );

        // activeTab must not be retried away — user needs to click the icon.
        if (/not been invoked|activeTab|active tab/i.test(raw)) {
          return {
            success: false,
            error: 'Extension has not been invoked for the current page. Click the MAO Chat toolbar icon on the video/meeting tab, then press Start.',
          };
        }

        if (attempt < maxAttempts && (isTransientTabCaptureError(raw) || !released)) {
          await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          continue;
        }
        break;
      }
    }

    const raw = lastError?.message || 'Failed to start tab capture';
    if (/not been invoked|activeTab|active tab/i.test(raw)) {
      return {
        success: false,
        error: 'Extension has not been invoked for the current page. Click the MAO Chat toolbar icon on the video/meeting tab, then press Start.',
      };
    }
    if (isTransientTabCaptureError(raw) || /still closing/i.test(raw)) {
      return {
        success: false,
        error: 'The previous tab-audio stream is still closing. Wait a moment and try again.',
      };
    }
    return { success: false, error: raw };

  } catch (error) {
    console.error('[Sokuji] [Background] Failed to start tab capture:', error);
    const raw = error?.message || 'Failed to start tab capture';
    // Map the classic activeTab failure to a clear, actionable message.
    if (/not been invoked|activeTab|active tab/i.test(raw)) {
      return {
        success: false,
        error: 'Extension has not been invoked for the current page. Click the MAO Chat toolbar icon on the video/meeting tab, then press Start.',
      };
    }
    return { success: false, error: raw };
  }
}

// Stop tab audio capture
async function handleStopTabCapture(tabId) {
  try {
    console.info('[Sokuji] [Background] Stopping tab capture for tab:', tabId);

    if (tabId && activeTabCaptures.has(tabId)) {
      activeTabCaptures.delete(tabId);
      console.info('[Sokuji] [Background] Tab capture stopped for tab:', tabId);
    }

    return { success: true };
  } catch (error) {
    console.error('[Sokuji] [Background] Failed to stop tab capture:', error);
    return { success: false, error: error.message };
  }
}
