// electron/quick-translate.js
// Native macOS Selection Translation & Screenshot OCR Translation
const { app, BrowserWindow, dialog, globalShortcut, ipcMain, clipboard, screen, shell, systemPreferences } = require('electron');
const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveOcrPath } = require('./ocr-path');

let quickTranslateWindow = null;
let isPinned = false;
let isCapturingScreenshot = false;
let lastShownTime = 0;
let latestPayload = { text: '', source: 'manual', timestamp: Date.now() };

/**
 * Safely focus the app to allow the floating window to receive keyboard input
 * without triggering app.on('activate') to unminimize/show the main window.
 */
function focusAppWithoutMainWindow() {
  if (process.platform === 'darwin') {
    global.suppressMainWindowActivation = true;
    app.focus({ steal: true });
    setTimeout(() => {
      global.suppressMainWindowActivation = false;
    }, 600);
  }
}

/**
 * Check and prompt for macOS screen recording permission.
 */
function checkScreenRecordingPermission() {
  if (process.platform !== 'darwin') return true;
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    return status === 'granted';
  } catch {
    return true;
  }
}

function promptScreenRecordingPermission(parentWindow) {
  focusAppWithoutMainWindow();
  const opts = {
    type: 'warning',
    title: '需要屏幕录制权限',
    message: 'MAO Chat 截图翻译需要「屏幕与系统音频录制」权限，否则截取的画面为空白。\n\n请在「系统设置 > 隐私与安全性 > 屏幕与系统音频录制」中开启 MAO Chat 的权限后重试。',
    buttons: ['前往系统设置', '稍后'],
    defaultId: 0,
    cancelId: 1,
  };
  const targetParent = (parentWindow && !parentWindow.isDestroyed() && parentWindow.isVisible() && parentWindow.isFocused()) ? parentWindow : null;
  (targetParent ? dialog.showMessageBox(targetParent, opts) : dialog.showMessageBox(opts))
    .then(({ response }) => {
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    });
}

/**
 * Check and prompt for macOS accessibility permission.
 */
function checkAccessibilityPermission(prompt = false) {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt);
  } catch {
    return true;
  }
}

function promptAccessibilityPermission(parentWindow) {
  focusAppWithoutMainWindow();
  const opts = {
    type: 'warning',
    title: '需要辅助功能权限',
    message: 'MAO Chat 划词翻译需要「辅助功能」权限以模拟按键复制当前选中的文本。\n\n• 如果刚安装或更新了软件：请在「系统设置 > 隐私与安全性 > 辅助功能」中将 MAO Chat 的开关先关闭再重新开启一次。\n• 您也可以先手动按 ⌘C 复制文本，再按 ⌃Q 翻译。',
    buttons: ['前往系统设置', '稍后'],
    defaultId: 0,
    cancelId: 1,
  };
  const targetParent = (parentWindow && !parentWindow.isDestroyed() && parentWindow.isVisible() && parentWindow.isFocused()) ? parentWindow : null;
  (targetParent ? dialog.showMessageBox(targetParent, opts) : dialog.showMessageBox(opts))
    .then(({ response }) => {
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
    });
}

/**
 * Capture currently selected text on macOS.
 * Uses native Accessibility query, hardware Cmd+C simulation, and clipboard fallback.
 */
async function captureSelectedText(parentWindow) {
  if (process.platform !== 'darwin') {
    return clipboard.readText() || '';
  }

  // Sanitize initial clipboard (clean up any leftover markers from previous runs)
  let rawInitial = clipboard.readText() || '';
  if (rawInitial.startsWith('__mao_clip_')) {
    clipboard.clear();
    rawInitial = '';
  }
  const initialClipboard = rawInitial.trim();

  // If QuickTranslateWindow is currently visible and active (e.g. user clicked in-app button),
  // hide it briefly so focus returns to the underlying application (e.g. browser)
  let shouldRestoreQuick = false;
  if (quickTranslateWindow && !quickTranslateWindow.isDestroyed() && quickTranslateWindow.isVisible()) {
    quickTranslateWindow.hide();
    shouldRestoreQuick = true;
    await new Promise((r) => setTimeout(r, 120));
  }

  const ocrBinary = resolveOcrPath();

  // Tier 1: Try reading selection directly via native mao-ocr --get-selection (Accessibility)
  if (ocrBinary) {
    try {
      const axText = await new Promise((resolve) => {
        execFile(ocrBinary, ['--get-selection'], { timeout: 250 }, (err, stdout) => {
          if (!err && stdout && stdout.trim().length > 0) {
            resolve(stdout.trim());
          } else {
            resolve('');
          }
        });
      });
      if (axText && axText.length > 0) {
        if (shouldRestoreQuick && quickTranslateWindow && !quickTranslateWindow.isDestroyed()) {
          quickTranslateWindow.show();
          quickTranslateWindow.focus();
        }
        return axText;
      }
    } catch (_) {}
  }

  // Tier 2: Simulate Cmd+C via native mao-ocr --simulate-copy
  // Clear clipboard first to detect if target app places new text
  clipboard.clear();

  if (ocrBinary) {
    try {
      await new Promise((resolve) => {
        execFile(ocrBinary, ['--simulate-copy'], { timeout: 250 }, () => resolve());
      });
    } catch (_) {}
  }

  // Poll clipboard for up to 250ms
  let copiedText = '';
  const start = Date.now();
  while (Date.now() - start < 250) {
    const text = clipboard.readText();
    if (text && text.trim().length > 0 && !text.startsWith('__mao_clip_')) {
      copiedText = text.trim();
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  // If mao-ocr didn't yield text, try AppleScript simulation fallback
  if (!copiedText) {
    try {
      await new Promise((resolve) => {
        exec(`osascript -e 'tell application "System Events" to keystroke "c" using {command down}'`, { timeout: 250 }, () => resolve());
      });
    } catch (_) {}

    const start2 = Date.now();
    while (Date.now() - start2 < 200) {
      const text = clipboard.readText();
      if (text && text.trim().length > 0 && !text.startsWith('__mao_clip_')) {
        copiedText = text.trim();
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  if (shouldRestoreQuick && quickTranslateWindow && !quickTranslateWindow.isDestroyed()) {
    quickTranslateWindow.show();
    quickTranslateWindow.focus();
  }

  if (copiedText) {
    return copiedText;
  }

  // Tier 3: If simulation did not yield new text, restore initial clipboard content
  if (initialClipboard && initialClipboard.length > 0 && !initialClipboard.startsWith('__mao_clip_')) {
    clipboard.writeText(initialClipboard);
    return initialClipboard;
  }

  // If both empty and accessibility not granted, prompt user
  const isTrusted = checkAccessibilityPermission(false);
  if (!isTrusted) {
    checkAccessibilityPermission(true);
    promptAccessibilityPermission(parentWindow);
  }

  return '';
}

/**
 * Capture screen area via macOS screencapture and run native Apple Vision OCR.
 */
async function captureScreenshotAndOcr(options = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Screenshot OCR is currently supported on macOS');
  }

  // Check Screen Recording permission
  const hasScreenAccess = checkScreenRecordingPermission();
  if (!hasScreenAccess) {
    promptScreenRecordingPermission(options.parentWindow);
    return { ok: false, error: 'permission_denied', permission: 'screen', text: '' };
  }

  const tmpFile = path.join(os.tmpdir(), `mao_ocr_${Date.now()}.png`);

  let shouldRestoreWindow = false;
  let windowToRestore = null;
  if (options.parentWindow && !options.parentWindow.isDestroyed() && options.parentWindow.isVisible() && options.parentWindow.isFocused()) {
    options.parentWindow.hide();
    shouldRestoreWindow = true;
    windowToRestore = options.parentWindow;
    await new Promise((r) => setTimeout(r, 120));
  } else if (quickTranslateWindow && !quickTranslateWindow.isDestroyed() && quickTranslateWindow.isVisible()) {
    quickTranslateWindow.hide();
    shouldRestoreWindow = true;
    windowToRestore = quickTranslateWindow;
    await new Promise((r) => setTimeout(r, 120));
  }

  isCapturingScreenshot = true;
  try {
    // 1. Run interactive silent screenshot (-i -x)
    await new Promise((resolve, reject) => {
      execFile('/usr/sbin/screencapture', ['-i', '-x', tmpFile], (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });

    if (shouldRestoreWindow && windowToRestore && !windowToRestore.isDestroyed()) {
      windowToRestore.show();
      windowToRestore.focus();
    }

    if (!fs.existsSync(tmpFile)) {
      // User cancelled screenshot (e.g. pressed ESC)
      return { ok: true, text: '', cancelled: true };
    }

    const stat = fs.statSync(tmpFile);
    if (stat.size === 0) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      return { ok: true, text: '', cancelled: true };
    }

    // 2. Resolve OCR binary
    const ocrBinary = resolveOcrPath();
    if (!ocrBinary) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw new Error('Native OCR tool not found');
    }

    // 3. Execute OCR
    const ocrText = await new Promise((resolve) => {
      execFile(ocrBinary, [tmpFile], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          console.warn('[QuickTranslate] OCR execution warning:', stderr || err.message);
        }
        resolve(stdout || '');
      });
    });

    try { fs.unlinkSync(tmpFile); } catch (_) {}
    const trimmed = (ocrText || '').trim();
    return { ok: true, text: trimmed, empty: trimmed.length === 0 };
  } catch (err) {
    if (shouldRestoreWindow && options.parentWindow && !options.parentWindow.isDestroyed()) {
      options.parentWindow.show();
      options.parentWindow.focus();
    }
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    // If user cancelled, don't throw
    if (err && err.code === 1) {
      return { ok: true, text: '', cancelled: true };
    }
    throw err;
  } finally {
    setTimeout(() => {
      isCapturingScreenshot = false;
    }, 400);
  }
}

/**
 * Create or retrieve the quick translate popup window.
 */
function getOrCreateQuickTranslateWindow(mainWindow) {
  if (quickTranslateWindow && !quickTranslateWindow.isDestroyed()) {
    return quickTranslateWindow;
  }

  const isDev = import.meta.env.MODE === 'development' || !app.isPackaged;

  quickTranslateWindow = new BrowserWindow({
    width: 480,
    height: 420,
    minWidth: 380,
    minHeight: 280,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: !isDev,
      backgroundThrottling: false,
    },
  });

  if (process.platform === 'darwin') {
    quickTranslateWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  quickTranslateWindow.setAlwaysOnTop(true, 'floating');

  if (isDev) {
    quickTranslateWindow.loadURL('http://localhost:5173/?window=quick-translate');
  } else {
    const indexPath = path.join(app.getAppPath(), 'build/index.html');
    quickTranslateWindow.loadFile(indexPath, { search: 'window=quick-translate' });
  }

  // Auto-hide when user clicks outside the window (blur) unless pinned
  quickTranslateWindow.on('blur', () => {
    setTimeout(() => {
      if (isPinned || isCapturingScreenshot || !quickTranslateWindow || quickTranslateWindow.isDestroyed()) {
        return;
      }
      if (quickTranslateWindow.isFocused()) {
        return;
      }
      quickTranslateWindow.hide();
    }, 150);
  });

  quickTranslateWindow.on('closed', () => {
    quickTranslateWindow = null;
  });

  return quickTranslateWindow;
}

/**
 * Show the quick translate window near the cursor or centered.
 */
function showQuickTranslate(text, source, mainWindow) {
  latestPayload = { text: text || '', source: source || 'manual', timestamp: Date.now() };

  const win = getOrCreateQuickTranslateWindow(mainWindow);

  // Position near cursor
  const mousePos = screen.getCursorScreenPoint();
  const currentDisplay = screen.getDisplayNearestPoint(mousePos);
  const workArea = currentDisplay.workArea;

  const winWidth = 480;
  const winHeight = 420;

  let x = mousePos.x - Math.round(winWidth / 2);
  let y = mousePos.y + 20;

  // Clamp within current display
  if (x + winWidth > workArea.x + workArea.width - 10) {
    x = workArea.x + workArea.width - winWidth - 10;
  }
  if (x < workArea.x + 10) {
    x = workArea.x + 10;
  }
  if (y + winHeight > workArea.y + workArea.height - 10) {
    // If not enough room below cursor, place above cursor
    y = mousePos.y - winHeight - 20;
    if (y < workArea.y + 10) {
      y = workArea.y + 10;
    }
  }

  lastShownTime = Date.now();
  win.setPosition(Math.round(x), Math.round(y));
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  focusAppWithoutMainWindow();

  // Send payload to renderer
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('quick-translate:payload', latestPayload);
    });
  } else {
    win.webContents.send('quick-translate:payload', latestPayload);
  }
}

/**
 * Setup IPC handlers and global shortcuts for quick translation.
 */
function setupQuickTranslate(mainWindow) {
  // 1. Register global shortcuts on macOS
  if (process.platform === 'darwin') {
    try {
      // 划词翻译: Control+Q
      globalShortcut.register('Control+Q', async () => {
        try {
          await new Promise((r) => setTimeout(r, 120));
          const selectedText = await captureSelectedText();
          if (selectedText && selectedText.trim().length > 0) {
            showQuickTranslate(selectedText, 'selection');
          } else {
            // When nothing is selected or text capture is empty, open quick translate with empty input
            // so the user can directly type or paste Cmd+V
            showQuickTranslate('', 'manual');
          }
        } catch (e) {
          console.warn('[QuickTranslate] Selection error:', e);
        }
      });

      // 截图翻译: Control+Z
      globalShortcut.register('Control+Z', async () => {
        try {
          const result = await captureScreenshotAndOcr();
          if (result?.text && result.text.length > 0) {
            showQuickTranslate(result.text, 'screenshot');
          } else if (result?.empty && !result?.cancelled) {
            focusAppWithoutMainWindow();
            dialog.showMessageBox({
              type: 'info',
              title: '未识别到文字',
              message: '选区内未识别到文字，请重新框选包含清晰文字的区域。',
            });
          }
        } catch (e) {
          console.warn('[QuickTranslate] Screenshot OCR error:', e);
        }
      });

      console.log('[QuickTranslate] Registered global shortcuts: Control+Q (Selection), Control+Z (Screenshot OCR)');
    } catch (e) {
      console.warn('[QuickTranslate] Failed to register global shortcuts:', e);
    }
  }

  // 2. Setup IPC handlers (must be registered once)
  ipcMain.handle('quick-translate:ocr-screenshot', async (event) => {
    try {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const res = await captureScreenshotAndOcr({ parentWindow: senderWindow });
      return res;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('quick-translate:capture-selection', async (event) => {
    try {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const text = await captureSelectedText(senderWindow);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('quick-translate:get-payload', () => {
    return latestPayload;
  });

  ipcMain.handle('quick-translate:set-pinned', (_event, pinned) => {
    isPinned = Boolean(pinned);
    if (quickTranslateWindow && !quickTranslateWindow.isDestroyed()) {
      quickTranslateWindow.setAlwaysOnTop(isPinned, 'floating');
    }
    return { ok: true, isPinned };
  });

  ipcMain.handle('quick-translate:close', () => {
    if (quickTranslateWindow && !quickTranslateWindow.isDestroyed()) {
      quickTranslateWindow.hide();
    }
    return { ok: true };
  });

  ipcMain.handle('quick-translate:open-main', (_event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      // Forward text into main window text translation
      mainWindow.webContents.send('quick-translate:open-in-main', payload || latestPayload);
    }
    if (quickTranslateWindow && !quickTranslateWindow.isDestroyed()) {
      quickTranslateWindow.hide();
    }
    return { ok: true };
  });
}

function cleanupQuickTranslate() {
  globalShortcut.unregisterAll();
  if (quickTranslateWindow && !quickTranslateWindow.isDestroyed()) {
    quickTranslateWindow.destroy();
    quickTranslateWindow = null;
  }
}

module.exports = {
  setupQuickTranslate,
  cleanupQuickTranslate,
  captureSelectedText,
  captureScreenshotAndOcr,
  showQuickTranslate,
  checkAccessibilityPermission,
};

