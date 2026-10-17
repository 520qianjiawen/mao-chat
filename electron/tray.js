// electron/tray.js
const { app, Tray, Menu, nativeImage, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  captureSelectedText,
  captureScreenshotAndOcr,
  showQuickTranslate,
  checkAccessibilityPermission,
} = require('./quick-translate');

let tray = null;
let getMainWindow = () => null;

/**
 * Resolve the tray icon image for the current platform.
 */
function getTrayIcon() {
  const isMac = process.platform === 'darwin';

  const candidates = [
    path.join(__dirname, '../assets/tray.png'),
    path.join(app.getAppPath(), 'assets/tray.png'),
    process.resourcesPath ? path.join(process.resourcesPath, 'assets/tray.png') : null,
    path.join(__dirname, '../assets/icon.png'),
    path.join(app.getAppPath(), 'assets/icon.png'),
    process.resourcesPath ? path.join(process.resourcesPath, 'assets/icon.png') : null,
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const icon = nativeImage.createFromPath(p);
        if (!icon.isEmpty()) {
          const iconSize = typeof icon.getSize === 'function' ? icon.getSize() : { width: 20, height: 20 };
          if (iconSize && iconSize.width <= 24 && iconSize.height <= 24) {
            return icon;
          }
          const size = isMac ? { width: 20, height: 20 } : { width: 16, height: 16 };
          return icon.resize({ ...size, quality: 'best' });
        }
      } catch (err) {
        console.warn('[Tray] Failed to load icon from', p, err);
      }
    }
  }

  return nativeImage.createEmpty();
}

/**
 * Build the context menu for the tray icon.
 */
function buildContextMenu() {
  const mainWindow = getMainWindow();
  const isVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();

  return Menu.buildFromTemplate([
    {
      label: '划词翻译',
      accelerator: 'Control+Q',
      click: async () => {
        try {
          const selectedText = await captureSelectedText();
          if (selectedText && selectedText.trim().length > 0) {
            showQuickTranslate(selectedText, 'selection');
          } else {
            showQuickTranslate('', 'manual');
          }
        } catch (e) {
          console.warn('[Tray] Selection capture error:', e);
        }
      },
    },
    {
      label: '截图翻译',
      accelerator: 'Control+Z',
      click: async () => {
        try {
          const result = await captureScreenshotAndOcr();
          if (result?.text && result.text.length > 0) {
            showQuickTranslate(result.text, 'screenshot');
          } else if (result?.empty && !result?.cancelled) {
            if (process.platform === 'darwin') {
              global.suppressMainWindowActivation = true;
              app.focus({ steal: true });
              setTimeout(() => {
                global.suppressMainWindowActivation = false;
              }, 500);
            }
            dialog.showMessageBox({
              type: 'info',
              title: '未识别到文字',
              message: '选区内未识别到文字，请重新框选包含清晰文字的区域。',
            });
          }
        } catch (e) {
          console.warn('[Tray] Screenshot OCR error:', e);
        }
      },
    },
    {
      label: '剪贴板翻译',
      click: () => {
        try {
          const text = clipboard.readText();
          if (text && text.trim().length > 0) {
            showQuickTranslate(text.trim(), 'clipboard');
          } else {
            showQuickTranslate('', 'manual');
          }
        } catch (e) {
          console.warn('[Tray] Clipboard translate error:', e);
        }
      },
    },
    {
      label: '显示翻译窗口',
      click: () => {
        showQuickTranslate('', 'manual');
      },
    },
    { type: 'separator' },
    {
      label: isVisible ? '隐藏主界面' : '打开主界面',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          if (process.platform === 'darwin') app.focus({ steal: true });
        }
      },
    },
    {
      label: '偏好设置...',
      accelerator: 'CmdOrCtrl+,',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        if (process.platform === 'darwin') app.focus({ steal: true });
        mainWindow.webContents.send('menu:open-settings');
      },
    },
    { type: 'separator' },
    {
      label: `MAO Chat v${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '退出',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/**
 * Setup status bar / tray icon and menu.
 */
function setupTray(mainWindowRef) {
  if (typeof mainWindowRef === 'function') {
    getMainWindow = mainWindowRef;
  } else {
    getMainWindow = () => mainWindowRef;
  }

  if (tray) {
    updateTrayMenu();
    return tray;
  }

  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('MAO Chat');

  updateTrayMenu();

  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.on('show', updateTrayMenu);
    mw.on('hide', updateTrayMenu);
  }

  tray.on('click', () => {
    const mainWindow = getMainWindow();
    if (process.platform !== 'darwin') {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      // On macOS, left click opens context menu
      tray.popUpContextMenu();
    }
  });

  return tray;
}

/**
 * Refresh the tray menu (e.g. when main window visibility changes).
 */
function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildContextMenu());
}

/**
 * Cleanup tray when app quits.
 */
function cleanupTray() {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}

module.exports = {
  setupTray,
  updateTrayMenu,
  cleanupTray,
  getTrayIcon,
};
