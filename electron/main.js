const { app, BrowserWindow, ipcMain, Menu, dialog, shell, session, systemPreferences, desktopCapturer, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { betterAuthAdapter } = require('./better-auth-adapter');
const { setupSubtitleHandlers } = require('./subtitle-window');
const { setupQuickTranslate, cleanupQuickTranslate } = require('./quick-translate');
const { setupTray, cleanupTray } = require('./tray');

// Handle Squirrel events for Windows
if (process.platform === 'win32') {
  const handleSquirrelEvent = require('./squirrel-events');
  if (handleSquirrelEvent()) {
    // Squirrel event handled and app will exit, don't do anything else
    process.exit(0);
  }
}

const { UpdateManager } = require('./update-manager');
const { NativeHostManager } = require('./native-host-manager');
const nativeHost = new NativeHostManager();

// Config utility no longer needed - using localStorage in renderer process

// Platform-specific audio utilities
let audioUtils;
if (process.platform === 'linux') {
  audioUtils = require('./pulseaudio-utils');
} else if (process.platform === 'win32') {
  audioUtils = require('./windows-audio-utils');
} else if (process.platform === 'darwin') {
  audioUtils = require('./macos-audio-utils');
} else {
  // For other platforms, provide stub implementations
  audioUtils = {
    createVirtualAudioDevices: async () => {
      console.log('[Sokuji] [Main] Virtual audio devices not supported on this platform');
      return false;
    },
    removeVirtualAudioDevices: () => {
      console.log('[Sokuji] [Main] Virtual audio device cleanup not needed on this platform');
    },
    cleanupOrphanedDevices: async () => {
      console.log('[Sokuji] [Main] No orphaned devices to clean on this platform');
      return true;
    }
  };
}

const {
  createVirtualAudioDevices,
  removeVirtualAudioDevices,
  cleanupOrphanedDevices,
  // System audio capture functions (stubs on all platforms, capture uses electron-audio-loopback)
  listSystemAudioSources,
  connectSystemAudioSource,
  disconnectSystemAudioSource,
  supportsSystemAudioCapture
} = audioUtils;

// Initialize electron-audio-loopback for system audio capture on all platforms
// MUST be called before app is ready
// Supports Windows, macOS, and Linux (via PulseaudioLoopbackForScreenShare Chromium flag)
{
  const { initMain } = require('electron-audio-loopback');
  initMain();
  console.log('[Sokuji] [Main] electron-audio-loopback initialized for', process.platform);
}

// Set application name for PulseAudio
app.setName('MAO Chat');
app.commandLine.appendSwitch('application-name', 'MAO Chat');
app.commandLine.appendSwitch('jack-name', 'sokuji');

// Enable WebGPU for ONNX Runtime acceleration
app.commandLine.appendSwitch('enable-unsafe-webgpu');
// Enable required Chromium features as a single comma-separated list
// (multiple appendSwitch calls for the same flag would override each other)
app.commandLine.appendSwitch('enable-features', 'Vulkan,SharedArrayBuffer');

// Keep the renderer (and its local-inference Web Worker) running at full speed when
// the Sokuji window is minimized/hidden/occluded — the common case while the user is
// in a video call with Sokuji translating in the background. Without these, Chromium
// backgrounds the hidden renderer and throttles its timers, which stalls the WASM
// inference loop (its setTimeout-based yields get clamped). See issue #263.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Windows sandbox crash self-healing (issue #352). On win32 only: apply the
// persistent --no-sandbox fallback (if a prior recovery set it) BEFORE app is
// ready, and register the passive GPU-crash detector. Recovery mode itself runs
// in whenReady (below), before the transparent main window is created.
const sandboxRecovery = process.platform === 'win32' ? require('./sandbox-recovery') : null;
// sandbox-recovery relaunches via app.exit(), which skips before-quit/will-quit,
// so it must run the sidecar teardown itself or the native sidecar orphans and
// keeps its Windows file locks. (removeVirtualAudioDevices is a Linux-only no-op.)
const sandboxRecoveryOptions = { deps: { beforeExit: () => { try { nativeHost.stop(); } catch (_) {} } } };
if (sandboxRecovery) {
  sandboxRecovery.applyNoSandboxFlag(app, sandboxRecoveryOptions);
  sandboxRecovery.registerCrashDetection(app, sandboxRecoveryOptions);
}

// Keep a global reference of the window object to prevent garbage collection
let mainWindow;

// Most recently computed virtual-audio-device status, forwarded to the
// renderer over the 'audio-status' channel once it's ready to receive it.
let lastAudioStatus = null;

/**
 * Figure out *why* virtual audio device setup failed so the renderer can show
 * an actionable message instead of a generic failure.
 * @returns {Promise<{ok: boolean, platform: string, reason: string | null, message: string | null}>}
 */
async function buildAudioStatus(devicesCreated) {
  if (devicesCreated) {
    return { ok: true, platform: process.platform, reason: null, message: null };
  }

  if (process.platform === 'linux') {
    const { isPactlInstalled } = audioUtils;
    const pactlInstalled = isPactlInstalled ? await isPactlInstalled() : true;
    if (!pactlInstalled) {
      return {
        ok: false,
        platform: 'linux',
        reason: 'pactl-missing',
        message: 'pactl (PulseAudio command-line tools) not found. Install it with: sudo apt install pulseaudio-utils'
      };
    }
    return {
      ok: false,
      platform: 'linux',
      reason: 'pulseaudio-unavailable',
      message: 'Could not create virtual audio devices. Make sure PulseAudio or PipeWire is running.'
    };
  }

  // macOS virtual mic requires the HAL driver installed by the official installer.
  // Never surface the Linux PulseAudio/PipeWire copy on Darwin.
  if (process.platform === 'darwin') {
    return {
      ok: false,
      platform: 'darwin',
      reason: 'macos-driver-missing',
      message:
        'MAO Chat Virtual Audio driver was not found. Reinstall with the official macOS installer, ' +
        'allow the driver in System Settings → Privacy & Security if blocked, then restart your Mac.',
    };
  }

  if (process.platform === 'win32') {
    return {
      ok: false,
      platform: 'win32',
      reason: 'windows-driver-missing',
      message:
        'VB-CABLE virtual audio driver was not found. Install VB-CABLE (or accept the in-app installer prompt) and retry.',
    };
  }

  return { ok: false, platform: process.platform, reason: 'other', message: 'Failed to create virtual audio devices' };
}

function sendAudioStatus(status) {
  lastAudioStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('audio-status', status);
  }
}

// Create application menu
function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const menuTemplate = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        {
          label: `About ${app.getName()}`,
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: `About ${app.getName()}`,
              message: 'MAO Chat - Real-time AI Translation',
              detail: `Version: ${app.getVersion()}\n\nAI-powered real-time translation application\n\n© 2026 Kizuna AI Lab`,
              buttons: ['OK'],
              icon: path.join(__dirname, '../assets/icon.png')
            });
          }
        },
        {
          label: '偏好设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.send('menu:open-settings');
            }
          }
        },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),

    // File menu
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },

    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [])
      ]
    },

    // Help menu
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [{
          label: `About ${app.getName()}`,
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: `About ${app.getName()}`,
              message: 'MAO Chat - Real-time AI Translation',
              detail: `Version: ${app.getVersion()}\n\nAI-powered real-time translation application\n\n© 2026 MAO Chat`,
              buttons: ['OK'],
              icon: path.join(__dirname, '../assets/icon.png')
            });
          }
        },
        { type: 'separator' }]),
        {
          label: 'Check for Updates...',
          click: () => {
            if (global.updateManager) {
              global.updateManager.checkForUpdates();
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  // Determine the correct icon path based on platform
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '../assets/icon.ico')
    : path.join(__dirname, '../assets/icon.png');

  // Create the browser window
  const isDev = import.meta.env.MODE === 'development' || !app.isPackaged;

  // Build custom User Agent to identify Electron app
  // Use standard OS names so PostHog's regex-based $os detection works
  const electronVersion = process.versions.electron;
  const appVersion = app.getVersion();
  const osName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform;
  const customUserAgent = `MAO Chat/${appVersion} Electron/${electronVersion} (${osName})`;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'MAO Chat',
    icon: iconPath,
    frame: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Disable web security in development to allow CORS requests
      webSecurity: !isDev,
      // Don't throttle timers/rendering when the window is hidden/occluded, so
      // local-inference (WASM) keeps running at full speed in the background. (#263)
      backgroundThrottling: false
    }
  });

  setupSubtitleHandlers(mainWindow);
  setupQuickTranslate(mainWindow);

  // Set custom User Agent for the window
  mainWindow.webContents.setUserAgent(customUserAgent);
  console.log('[Sokuji] [Main] Custom User Agent set:', customUserAgent);

  // Load the app
  console.log('[Sokuji] [Main] Development mode:', isDev, 'MODE:', import.meta.env.MODE, 'isPackaged:', app.isPackaged);
  
  // Track window load time
  const loadStartTime = Date.now();
  
  // Add performance tracking for page load
  mainWindow.webContents.on('did-finish-load', () => {
    const loadEndTime = Date.now();
    console.log(`[Sokuji] [Main] Page loaded in ${loadEndTime - loadStartTime}ms`);

    // Forward the virtual-audio-device status computed during startup, now
    // that the renderer is actually able to receive it.
    if (lastAudioStatus) {
      sendAudioStatus(lastAudioStatus);
    }
  });
  
  mainWindow.webContents.on('dom-ready', () => {
    const domReadyTime = Date.now();
    console.log(`[Sokuji] [Main] DOM ready in ${domReadyTime - loadStartTime}ms`);
  });
  
  if (isDev) {
    console.log(`[Sokuji] [Main] Loading from http://localhost:5173 at ${loadStartTime}`);
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const indexPath = path.join(app.getAppPath(), 'build/index.html');
    console.log('[Sokuji] [Main] Loading from:', indexPath);
    mainWindow.loadFile(indexPath);
  }

  // Open DevTools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Intercept window close: hide to tray instead of quitting
  mainWindow.on('close', function (event) {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  // Emitted when the window is closed
  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// Create window when Electron is ready
app.whenReady().then(async () => {
  // Windows sandbox recovery (issue #352): if a prior run left a crash marker,
  // scan ACLs and show the native recovery dialog BEFORE creating the (transparent)
  // main window. May relaunch or exit; if so, do not proceed to createWindow().
  if (sandboxRecovery && !sandboxRecovery.handleRecoveryMode(app, dialog, sandboxRecoveryOptions)) {
    return;
  }

  const isDev = import.meta.env.MODE === 'development' || !app.isPackaged;

  // Initialize Better Auth adapter
  try {
    const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8787';
    const origin = isDev ? 'http://localhost:5173' : `file://${__dirname}`;

    console.log(`[Sokuji] [Main] Initializing Better Auth adapter with backend: ${backendUrl}, origin: ${origin}`);

    betterAuthAdapter({
      backendUrl,
      origin
    });
    console.log('[Sokuji] [Main] Better Auth adapter initialized');
  } catch (error) {
    console.error('[Sokuji] [Main] Error initializing Better Auth adapter:', error);
  }

  // Initialize WebSocket header injection (must be before any WebSocket connections)
  initWebSocketHeaderInjection();

  // Clean up any orphaned devices
  try {
    await cleanupOrphanedDevices();
    console.log('[Sokuji] [Main] Orphaned devices cleaned up successfully');
  } catch (error) {
    console.error('[Sokuji] [Main] Error cleaning up orphaned devices:', error);
  }

  // Start virtual audio devices before creating the window
  try {
    const devicesCreated = await createVirtualAudioDevices();
    lastAudioStatus = await buildAudioStatus(devicesCreated);
    if (!devicesCreated) {
      console.error('[Sokuji] [Main] Virtual audio device status:', lastAudioStatus.reason, '-', lastAudioStatus.message);
    }
    if (devicesCreated) {
      console.log('[Sokuji] [Main] Virtual audio devices created successfully');
      
      // Connect the virtual speaker to the default output device
      // try {
      //   // Use default device info
      //   const defaultDeviceInfo = {
      //     deviceId: 'default',
      //     label: 'Default'
      //   };
      //
      //   // Connect virtual speaker to default output
      //   const connected = await connectVirtualSpeakerToOutput(defaultDeviceInfo);
      //   if (connected) {
      //     console.log('[Sokuji] [Main] Successfully connected virtual speaker to default output device');
      //   } else {
      //     console.error('[Sokuji] [Main] Failed to connect virtual speaker to default output device');
      //   }
      // } catch (connectionError) {
      //   console.error('[Sokuji] [Main] Error connecting virtual speaker to default output:', connectionError);
      // }
    } else {
      console.error('[Sokuji] [Main] Failed to create virtual audio devices');
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error creating virtual audio devices:', error);
    lastAudioStatus = { ok: false, platform: process.platform, reason: 'other', message: error?.message || 'Failed to create virtual audio devices' };
  }

  // Create the application menu
  createApplicationMenu();

  // Request microphone permission on macOS before creating window
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log('[Sokuji] [Main] Microphone permission status:', micStatus);

    if (micStatus === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      console.log('[Sokuji] [Main] Microphone permission granted:', granted);
    } else if (micStatus === 'denied') {
      console.warn('[Sokuji] [Main] Microphone permission denied - please enable in System Preferences > Privacy & Security > Microphone');
    }
  }

  createWindow();
  setupTray(() => mainWindow);

  // On macOS: detect version upgrade and guide user to grant/refresh Accessibility permission
  checkAndPromptAccessibilityOnUpdate(mainWindow);

  // Initialize auto-update manager
  global.updateManager = new UpdateManager(mainWindow);
  global.updateManager.checkAfterDelay(5000);

  // electron-audio-loopback handles setDisplayMediaRequestHandler automatically via initMain()
});

/**
 * On macOS, check if this is an update or fresh run, and guide users to
 * grant / refresh Accessibility permission for selection translation.
 */
function checkAndPromptAccessibilityOnUpdate(parentWindow) {
  if (process.platform !== 'darwin') return;
  try {
    const versionFile = path.join(app.getPath('userData'), '.last-run-version');
    const currentVersion = app.getVersion();
    let lastVersion = null;
    if (fs.existsSync(versionFile)) {
      try {
        lastVersion = fs.readFileSync(versionFile, 'utf8').trim();
      } catch {}
    }
    fs.writeFileSync(versionFile, currentVersion, 'utf8');

    const isUpdate = Boolean(lastVersion && lastVersion !== currentVersion);
    const isFirstRun = !lastVersion;

    // Check accessibility status
    const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);

    // If it's a version update (e.g. 1.0.25 -> 1.0.26) or permissions not yet granted on first run:
    if (isUpdate || (!isTrusted && isFirstRun)) {
      systemPreferences.isTrustedAccessibilityClient(true);

      setTimeout(() => {
        if (process.platform === 'darwin') {
          app.focus({ steal: true });
        }
        const opts = {
          type: 'info',
          title: isUpdate ? '软件已更新至新版本' : '需要辅助功能权限',
          message: isUpdate
            ? `MAO Chat 已更新至 v${currentVersion}。\n\n由于 macOS 安全防护机制，软件更新后若划词翻译未自动取词，通常是因为系统临时挂起了「辅助功能」授权。\n\n请在「系统设置 > 隐私与安全性 > 辅助功能」中将 MAO Chat 重新开关一次即可恢复。`
            : 'MAO Chat 划词翻译功能需要「辅助功能」权限以模拟按键复制当前选中的文本。\n\n请在「系统设置 > 隐私与安全性 > 辅助功能」中允许 MAO Chat。',
          buttons: ['前往系统设置', isUpdate ? '我知道了' : '稍后'],
          defaultId: 0,
          cancelId: 1,
        };
        (parentWindow && !parentWindow.isDestroyed() ? dialog.showMessageBox(parentWindow, opts) : dialog.showMessageBox(opts))
          .then(({ response }) => {
            if (response === 0) {
              shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
            }
          });
      }, 1500);
    }
  } catch (err) {
    console.warn('[Sokuji] [Main] Error checking accessibility on update:', err);
  }
}

// Ensure cleanup happens before app exits
const cleanupAndExit = () => {
  console.log('[Sokuji] [Main] Cleaning up virtual audio devices before exit...');
  removeVirtualAudioDevices();
  try {
    if (typeof disconnectSystemAudioSource === 'function') {
      disconnectSystemAudioSource();
    }
  } catch (error) {
    console.warn('[Sokuji] [Main] Failed to disconnect system audio source on exit:', error);
  }
  nativeHost.stop();
  cleanupQuickTranslate();
  cleanupTray();
  console.log('[Sokuji] [Main] Virtual audio devices cleaned up successfully');
};

// Create a more robust exit handler that ensures cleanup happens
const handleExit = (signal) => {
  console.log(`[Sokuji] [Main] Received ${signal} signal. Ensuring cleanup before exit...`);
  
  // Perform cleanup synchronously
  cleanupAndExit();
  
  // Exit with appropriate code
  const exitCode = signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1;
  process.exit(exitCode);
};

// Register cleanup function with app's before-quit event
app.on('before-quit', () => {
  app.isQuitting = true;
  cleanupAndExit();
});

// Register our exit handler for various signals
process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[Sokuji] [Main] Uncaught exception:', error);
  handleExit('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Sokuji] [Main] Unhandled rejection at:', promise, 'reason:', reason);
  handleExit('unhandledRejection');
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  // If activation is suppressed (e.g. quick-translate floating window taking focus), do not touch mainWindow
  if (global.suppressMainWindowActivation) {
    return;
  }
  // On macOS, recreate the window when the dock icon is clicked or restore if hidden
  if (mainWindow === null) {
    createWindow();
    // Update the manager's window reference so IPC messages reach the new renderer
    if (global.updateManager) {
      global.updateManager.setMainWindow(mainWindow);
    }
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Clean up loopback when app is about to quit
app.on('will-quit', cleanupAndExit);

// IPC handler for app version
nativeHost.registerIpc(ipcMain);

// ---- Self-contained sidecar bundle install/status (distribution spec) ----
// SKU detection + bundle download live in the main process because the sidecar
// (which the bundle provides) is not yet running. Progress is pushed to the
// renderer on 'sidecar-bundle-progress', mirroring the model-download UX.
const { detectSku: _detectSku, probeNvidia: _probeNvidia, nvidiaGpuName: _nvidiaGpuName } = require('./sidecar-sku');
const { resolvePython: _resolveSidecarPython } = require('./native-host-manager');
const sidecarBundle = require('./sidecar-bundle');
const _currentSku = () =>
  _detectSku(process.platform, { hasNvidia: _probeNvidia(), arch: process.arch });
const _embeddedSidecarRoot = () =>
  app.isPackaged && process.platform === 'darwin'
    ? require('path').join(process.resourcesPath, 'sidecar-runtime')
    : null;
const _embeddedSidecarPresent = () => {
  const root = _embeddedSidecarRoot();
  return !!root && require('fs').existsSync(require('path').join(root, 'python', 'bin', 'python3'));
};
ipcMain.handle('sidecar-bundle:status', () => {
  const sku = _currentSku();
  if (_embeddedSidecarPresent()) {
    const version = sidecarBundle.requiredSidecarVersion();
    return { ok: true, sku: sku || 'mac', state: 'ready', installed: true,
             installedVersion: version, requiredVersion: version, gpuName: null,
             stagedBytes: 0, devVenvPresent: false, embedded: true };
  }
  if (sku === null) {
    // Even without a bundle SKU (ARM linux/windows, Intel mac) a dev checkout
    // with a venv keeps the whole native lane usable — report it so the UI
    // shows the dev note + unlocked model area instead of a dead end.
    let devVenvPresent = false;
    try { devVenvPresent = require('fs').existsSync(_resolveSidecarPython()); } catch { /* keep false */ }
    return { ok: true, sku: null, state: 'unsupported', installed: false,
             installedVersion: null, requiredVersion: null, gpuName: null,
             stagedBytes: 0, devVenvPresent };
  }
  let requiredVersion = null;
  try { requiredVersion = sidecarBundle.requiredSidecarVersion(); }
  catch { /* tree without the field — no version gate */ }
  const st = sidecarBundle.bundleStatus(app.getPath('userData'), sku);
  // Strict matching (spec S2): an installed bundle at any other version is a
  // 'mismatch' — the renderer presents it as "engine update required".
  const state = !st.installed ? 'absent'
    : (requiredVersion === null || st.version === requiredVersion) ? 'ready' : 'mismatch';
  let devVenvPresent = false;
  try { devVenvPresent = require('fs').existsSync(_resolveSidecarPython()); } catch { /* keep false */ }
  return {
    ok: true, sku, state,
    installed: st.installed, installedVersion: st.version, requiredVersion,
    gpuName: _nvidiaGpuName(),
    stagedBytes: requiredVersion === null ? 0
      : sidecarBundle.stagedBytes(app.getPath('userData'), sku, requiredVersion),
    devVenvPresent,
  };
});
// Best-effort manifest peek so the engine card can show exact sizes pre-install.
ipcMain.handle('sidecar-bundle:manifest', async () => {
  const sku = _currentSku();
  if (_embeddedSidecarPresent()) return { ok: true, size: 0, installedSize: null, embedded: true };
  if (sku === null) return { ok: false, error: 'unsupported platform' };
  try {
    const version = sidecarBundle.requiredSidecarVersion();
    const r = await fetch(`${sidecarBundle.bundleBaseUrl(version)}/manifest.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const entry = sidecarBundle.pickBundle(await r.json(), sku);
    if (!entry) throw new Error(`no bundle for sku ${sku}`);
    return { ok: true, size: entry.size ?? null, installedSize: entry.installedSize ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
// In-flight guard + cancellation. Cancel aborts the network stream but KEEPS
// the staging files — re-invoking install resumes from the staged bytes (S7).
let _bundleInstalling = false;
let _bundleAbort = null;
ipcMain.handle('sidecar-bundle:install', async (event) => {
  const sku = _currentSku();
  if (_embeddedSidecarPresent()) {
    return { ok: true, sku: sku || 'mac', version: sidecarBundle.requiredSidecarVersion(), embedded: true };
  }
  if (sku === null) return { ok: false, sku: null, error: 'no sidecar bundle for this platform' };
  if (_bundleInstalling) return { ok: false, sku, error: 'bundle install already in progress' };
  _bundleInstalling = true;
  _bundleAbort = new AbortController();
  try {
    const r = await sidecarBundle.installBundle({
      sku,
      version: sidecarBundle.requiredSidecarVersion(),
      userDataDir: app.getPath('userData'),
      signal: _bundleAbort.signal,
      stopSidecar: () => nativeHost.stop(),
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('sidecar-bundle-progress', { sku, ...p });
      },
    });
    return { ok: true, sku, ...r };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, sku, cancelled: true };
    return { ok: false, sku, error: e instanceof Error ? e.message : String(e) };
  } finally {
    _bundleInstalling = false;
    _bundleAbort = null;
  }
});
ipcMain.handle('sidecar-bundle:cancel', () => {
  _bundleAbort?.abort();
  return { ok: true };
});
ipcMain.handle('sidecar-bundle:remove', () => {
  if (_embeddedSidecarPresent()) return { ok: false, embedded: true, error: 'embedded engine is part of the application' };
  const sku = _currentSku();
  if (sku === null) return { ok: false, error: 'unsupported platform' };
  nativeHost.stop();  // release file locks before deleting (Windows)
  sidecarBundle.removeBundle(app.getPath('userData'), sku);
  return { ok: true };
});

ipcMain.handle('get-app-version', () => app.getVersion());

// DeepL API has no CORS headers — production Electron (webSecurity on) cannot
// call it from the renderer. Proxy only the official Free/Pro hosts.
const DEEPL_ALLOWED_HOSTS = new Set(['api.deepl.com', 'api-free.deepl.com']);
ipcMain.handle('deepl-fetch', async (_event, payload) => {
  try {
    const url = typeof payload?.url === 'string' ? payload.url : '';
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: 0, headers: {}, body: '', error: 'invalid URL' };
    }
    if (parsed.protocol !== 'https:' || !DEEPL_ALLOWED_HOSTS.has(parsed.hostname)) {
      return { ok: false, status: 0, headers: {}, body: '', error: 'host not allowed' };
    }
    const method = (payload?.method || 'GET').toUpperCase();
    const headers = payload?.headers && typeof payload.headers === 'object' ? payload.headers : {};
    const body = method === 'GET' || method === 'HEAD' ? undefined : (payload?.body ?? undefined);
    const res = await net.fetch(url, { method, headers, body });
    const text = await res.text();
    const outHeaders = {};
    res.headers.forEach((value, key) => { outHeaders[key] = value; });
    return { ok: res.ok, status: res.status, headers: outHeaders, body: text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: {},
      body: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

// Ollama API proxy (local daemon on localhost / 127.0.0.1)
const OLLAMA_ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);
ipcMain.handle('ollama-fetch', async (_event, payload) => {
  try {
    const url = typeof payload?.url === 'string' ? payload.url : '';
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: 0, headers: {}, body: '', error: 'invalid URL' };
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !OLLAMA_ALLOWED_HOSTS.has(parsed.hostname)) {
      return { ok: false, status: 0, headers: {}, body: '', error: 'host not allowed' };
    }
    const method = (payload?.method || 'GET').toUpperCase();
    const headers = payload?.headers && typeof payload.headers === 'object' ? payload.headers : {};
    const body = method === 'GET' || method === 'HEAD' ? undefined : (payload?.body ?? undefined);
    const res = await net.fetch(url, { method, headers, body });
    const text = await res.text();
    const outHeaders = {};
    res.headers.forEach((value, key) => { outHeaders[key] = value; });
    return { ok: res.ok, status: res.status, headers: outHeaders, body: text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: {},
      body: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

// IPC handler for the renderer to pull the current virtual-audio-device status.
// The renderer's listener for the 'audio-status' push isn't guaranteed to be
// registered yet when 'did-finish-load' fires (React mounts asynchronously),
// so relying on the push alone can silently drop the event. The renderer
// pulls this once right after it subscribes, to cover that race.
ipcMain.handle('get-audio-status', () => lastAudioStatus);

// ---- Window controls for the custom title bar ----
ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.handle('window:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// IPC handlers for audio functionality
ipcMain.handle('check-audio-system', async () => {
  try {
    let audioSystemAvailable = false;
    let systemType = 'none';

    if (process.platform === 'linux') {
      const { isPulseAudioAvailable } = audioUtils;
      audioSystemAvailable = await isPulseAudioAvailable();
      systemType = audioSystemAvailable ? 'pulseaudio' : 'none';
    } else if (process.platform === 'win32') {
      const { isWindowsAudioAvailable } = audioUtils;
      audioSystemAvailable = await isWindowsAudioAvailable();
      // On Windows, VB-CABLE detection happens in the renderer process
      // We just report that Windows audio is available
      systemType = audioSystemAvailable ? 'windows' : 'none';
    } else if (process.platform === 'darwin') {
      const { isMacOSAudioAvailable } = audioUtils;
      audioSystemAvailable = await isMacOSAudioAvailable();
      // On macOS, Sokuji Virtual Audio driver is installed by PKG installer
      systemType = audioSystemAvailable ? 'coreaudio' : 'none';
    }

    return {
      audioSystemAvailable,
      systemType,
      platform: process.platform,
      note: process.platform === 'win32' ? 'VB-CABLE detection happens in renderer process' :
            process.platform === 'darwin' ? 'Sokuji Virtual Audio driver installed by PKG installer' : null
    };
  } catch (error) {
    console.error('[Sokuji] [Main] Error checking audio system status:', error);
    return {
      audioSystemAvailable: false,
      systemType: 'none',
      platform: process.platform,
      error: error.message
    };
  }
});

// Handler for VB-CABLE detection (called from renderer process)
ipcMain.handle('check-vbcable', async () => {
  try {
    // On Windows, actual VB-CABLE detection happens in the renderer process
    // This handler is here for consistency and future extensibility
    if (process.platform === 'win32') {
      return {
        platform: 'windows',
        detectionMethod: 'renderer',
        message: 'VB-CABLE detection should be done via MediaDevices API in renderer'
      };
    } else {
      return {
        platform: process.platform,
        detectionMethod: 'none',
        message: 'VB-CABLE is Windows-specific'
      };
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error in VB-CABLE check:', error);
    return {
      error: error.message
    };
  }
});

// Handler for VB-CABLE installation (called from renderer process)
ipcMain.handle('install-vbcable', async () => {
  try {
    if (process.platform === 'win32') {
      console.log('[Sokuji] [Main] VB-CABLE installation requested from renderer');
      const installer = require('./vb-cable-installer');
      const result = await installer.ensureVBCableInstalled();
      return {
        success: result,
        platform: 'windows'
      };
    } else {
      return {
        success: false,
        platform: process.platform,
        message: 'VB-CABLE is Windows-specific'
      };
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error installing VB-CABLE:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Handler for Sokuji Virtual Audio detection (called from renderer process)
ipcMain.handle('check-sokuji-audio', async () => {
  try {
    if (process.platform === 'darwin') {
      const { isSokujiVirtualAudioInstalled } = audioUtils;
      const installed = await isSokujiVirtualAudioInstalled();
      return {
        installed,
        platform: 'macos',
        driverName: 'Sokuji Virtual Audio'
      };
    } else {
      return {
        installed: false,
        platform: process.platform,
        message: 'Sokuji Virtual Audio is macOS-specific'
      };
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error in Sokuji Virtual Audio check:', error);
    return {
      installed: false,
      error: error.message
    };
  }
});

// Configuration now handled directly in renderer process via localStorage

// Handler to open a directory in the file explorer
ipcMain.handle('open-directory', (event, dirPath) => {
  try {
    // Open the directory using the default file explorer
    const { shell } = require('electron');
    shell.openPath(dirPath);
    return { success: true };
  } catch (error) {
    console.error('[Sokuji] [Main] Error opening directory:', error);
    return { success: false, error: error.message };
  }
});

// Handler to open external URL in system default browser
ipcMain.handle('open-external', async (event, url) => {
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('[Sokuji] [Main] Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});




// Handler to create virtual audio devices (used for manual retry from the renderer)
ipcMain.handle('create-virtual-speaker', async () => {
  try {
    const result = await createVirtualAudioDevices();
    const status = await buildAudioStatus(result);
    sendAudioStatus(status);
    return {
      success: result,
      message: result ? 'Virtual audio devices created successfully' : status.message
    };
  } catch (error) {
    console.error('[Sokuji] [Main] Error creating virtual audio devices:', error);
    sendAudioStatus({ ok: false, platform: process.platform, reason: 'other', message: error?.message || 'Failed to create virtual audio devices' });
    return {
      success: false,
      error: error?.message || 'Failed to create virtual audio devices'
    };
  }
});

// System audio capture IPC handlers (Linux only)
ipcMain.handle('supports-system-audio-capture', async () => {
  if (supportsSystemAudioCapture) {
    return await supportsSystemAudioCapture();
  }
  return false;
});

ipcMain.handle('list-system-audio-sources', async () => {
  if (listSystemAudioSources) {
    return await listSystemAudioSources();
  }
  return [];
});

ipcMain.handle('connect-system-audio-source', async (event, sinkName) => {
  if (connectSystemAudioSource) {
    return await connectSystemAudioSource(sinkName);
  }
  return { success: false, error: 'System audio capture not supported on this platform' };
});

ipcMain.handle('disconnect-system-audio-source', async () => {
  if (disconnectSystemAudioSource) {
    return await disconnectSystemAudioSource();
  }
  return { success: false };
});

// Per-application audio capture (Windows/macOS, issue #335).
// The helper writes PCM to its stdout; we forward each chunk straight to the
// renderer that asked for it. 24 kHz mono s16 is ~48 KB/s, so plain IPC is
// ample and avoids putting a listening socket on the machine.
ipcMain.handle('start-app-audio-capture', async (event, deviceId) => {
  // Linux does not come through here: its tap is a PipeWire link and the
  // renderer records the resulting monitor device with getUserMedia.
  const helperModule = process.platform === 'win32' ? './windows-audio-utils'
    : process.platform === 'darwin' ? './macos-audio-utils'
    : null;
  if (!helperModule) {
    return { ok: false, error: 'Per-application capture helper is not available on this platform' };
  }
  try {
    const { startCapture } = require(helperModule);
    const wc = event.sender;
    const ok = startCapture(
      deviceId,
      // A Buffer does not survive the context-bridge as-is; a Uint8Array view does.
      (pcm) => { if (!wc.isDestroyed()) wc.send('app-audio:pcm', new Uint8Array(pcm)); },
      (evt) => { if (!wc.isDestroyed()) wc.send('app-audio:event', evt); }
    );
    return ok ? { ok: true } : { ok: false, error: 'Capture helper unavailable' };
  } catch (error) {
    console.error('[Sokuji] [Main] Failed to start application audio capture:', error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('stop-app-audio-capture', async () => {
  const helperModule = process.platform === 'win32' ? './windows-audio-utils'
    : process.platform === 'darwin' ? './macos-audio-utils'
    : null;
  if (!helperModule) return { ok: true };
  try {
    const { stopCapture } = require(helperModule);
    stopCapture();
  } catch (error) {
    console.warn('[Sokuji] [Main] Failed to stop application audio capture:', error);
  }
  return { ok: true };
});

// Linux loopback audio: fix PipeWire monitor source volume
// PipeWire stores an independent monitorVolumes property per sink that can be very low.
// After getDisplayMedia() creates the loopback stream, we force the monitor source to 100%.
ipcMain.handle('fix-monitor-volume', async () => {
  if (process.platform !== 'linux') return { ok: true, skipped: true };

  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync('pactl', ['get-default-sink'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const defaultSink = stdout.trim();
    const monitorName = defaultSink + '.monitor';
    await execFileAsync('pactl', ['set-source-volume', monitorName, '100%'], {
      timeout: 2000,
    });
    console.log(`[Sokuji] [Main] Fixed monitor volume for ${monitorName}`);
    return { ok: true, monitor: monitorName };
  } catch (err) {
    console.error('[Sokuji] [Main] Failed to fix monitor volume:', err.message);
    return { ok: false, error: err.message };
  }
});

// ── Combined Request Header Injection ─────────────────────────────────────────
// Electron only allows ONE onBeforeSendHeaders listener per session, so this
// single handler covers both:
//   1. Better Auth: cookie/origin injection for backend API requests
//   2. WebSocket: custom header injection for provider WebSocket upgrades
//
// The renderer registers host-specific WebSocket header rules via IPC before
// opening a WebSocket connection. This replaces the previous per-provider IPC
// bridges (Volcengine, Edge TTS) that proxied every frame through main process.

// Map<host, Map<headerName, headerValue>>
const wsHeaderRules = new Map();

function initWebSocketHeaderInjection() {
  // Retrieve Better Auth config (stored by better-auth-adapter.js)
  const authConfig = betterAuthAdapter._sendHeadersConfig;

  // Pre-parse auth URL matchers for safe origin+path comparison
  const authMatchers = authConfig
    ? authConfig.filterPatterns.map((pattern) => {
        const base = pattern.replace(/\/\*$/, '');
        const parsed = new URL(base);
        return { origin: parsed.origin, pathname: parsed.pathname.replace(/\/$/, '') || '' };
      })
    : [];

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const { requestHeaders } = details;

      // ── Better Auth: inject cookies and origin for backend requests ──
      if (authConfig && authMatchers.length > 0) {
        let isAuthRequest = false;
        try {
          const reqUrl = new URL(details.url);
          isAuthRequest = authMatchers.some(({ origin, pathname }) =>
            reqUrl.origin === origin &&
            (pathname === '' || reqUrl.pathname === pathname || reqUrl.pathname.startsWith(pathname + '/'))
          );
        } catch {
          // Malformed URL — not an auth request
        }
        if (isAuthRequest) {
          if (authConfig.origin) {
            const cleanOrigin = authConfig.origin.endsWith('/')
              ? authConfig.origin.slice(0, -1)
              : authConfig.origin;
            requestHeaders['Origin'] = cleanOrigin.toLowerCase();
            requestHeaders['Referer'] = cleanOrigin.toLowerCase();
          }
          authConfig.injectCookies(requestHeaders);
        }
      }

      // ── WebSocket: inject custom headers for provider connections ────
      // One-shot: headers are consumed on first use and removed from the map,
      // so they only apply to the intended upgrade handshake.
      if (details.resourceType === 'webSocket') {
        try {
          const url = new URL(details.url);
          const headers = wsHeaderRules.get(url.host);
          if (headers) {
            for (const [name, value] of headers.entries()) {
              requestHeaders[name] = value;
            }
            wsHeaderRules.delete(url.host);
          }
        } catch {
          // Invalid URL — pass through unchanged
        }
      }

      // Bing Translator (HTTP): inject browser-like identity so the unofficial
      // www/cn.bing.com translator + ttranslatev3 endpoints accept requests from
      // Electron. Must be applied unconditionally — the Bing client runs inside
      // a Web Worker and fetch() from there cannot set Origin/Referer itself.
      // (Edge JWT auth is currently 404 in many regions; scrape path is primary.)
      if (
        details.resourceType !== 'webSocket'
        && typeof details.url === 'string'
        && (
          details.url.startsWith('https://www.bing.com/translator')
          || details.url.startsWith('https://www.bing.com/ttranslatev3')
          || details.url.startsWith('https://cn.bing.com/translator')
          || details.url.startsWith('https://cn.bing.com/ttranslatev3')
        )
      ) {
        const isCn = details.url.startsWith('https://cn.bing.com/');
        const origin = isCn ? 'https://cn.bing.com' : 'https://www.bing.com';
        requestHeaders['User-Agent'] =
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
        requestHeaders['Origin'] = origin;
        requestHeaders['Referer'] = `${origin}/translator`;
        requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
      }

      callback({ requestHeaders });
    }
  );

  console.log('[Sokuji] [Main] Combined header injection initialized');
}

// IPC: renderer registers headers for a host before opening a WebSocket
ipcMain.handle('ws-headers-set', (event, { host, headers }) => {
  if (!host || !headers || typeof headers !== 'object') {
    return { success: false, error: 'Invalid arguments: host and headers required' };
  }
  // Coerce all values to strings — Chromium silently drops headers with non-string values.
  // IPC serialization can turn numeric strings (e.g. App ID "1714584595") into numbers.
  const entries = Object.entries(headers)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, String(v)]);
  const headerMap = new Map(entries);
  wsHeaderRules.set(host, headerMap);
  console.log(`[Sokuji] [Main] WS headers registered for ${host}: ${[...headerMap.keys()].join(', ')}`);
  return { success: true };
});

// IPC: renderer clears headers for a host after disconnecting
ipcMain.handle('ws-headers-clear', (event, { host }) => {
  if (!host) {
    return { success: false, error: 'Invalid arguments: host required' };
  }
  wsHeaderRules.delete(host);
  console.log(`[Sokuji] [Main] WS headers cleared for ${host}`);
  return { success: true };
});

// Open the exact macOS privacy pane a denied capture needs. The anchor names
// are the ones System Settings itself advertises: Privacy_AudioCapture is
// "System Audio Recording Only" and Privacy_ScreenCapture is "Screen Recording".
const PRIVACY_PANES = {
  'audio-capture': 'Privacy_AudioCapture',
  'screen-recording': 'Privacy_ScreenCapture',
  'accessibility': 'Privacy_Accessibility',
};

/**
 * The name macOS shows for this process in the privacy lists.
 *
 * In a packaged build that is "MAO Chat", but `npm run electron:dev` runs
 * Electron's own bundle (com.github.Electron), so the user has to grant the
 * permission to "Electron". Telling them to look for "MAO Chat" there sends
 * them hunting for an entry that does not exist.
 */
ipcMain.handle('get-tcc-display-name', async () => {
  if (process.platform !== 'darwin') return { name: app.getName(), isDev: false };
  const exe = app.getPath('exe');
  const isDev = exe.includes('node_modules/electron/dist/');
  return { name: isDev ? 'Electron' : app.getName(), isDev };
});

ipcMain.handle('open-privacy-settings', async (event, pane) => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Privacy panes are macOS-only' };
  }
  const anchor = PRIVACY_PANES[pane];
  if (!anchor) {
    return { ok: false, error: `Unknown privacy pane: ${pane}` };
  }
  try {
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
    return { ok: true };
  } catch (error) {
    console.error('[Sokuji] [Main] Failed to open privacy settings:', error);
    return { ok: false, error: error.message };
  }
});

// Screen recording permission check for macOS system audio capture
// This only checks the permission status, does NOT trigger any permission dialogs
// The renderer should call getDisplayMedia() to trigger the system dialog when needed
ipcMain.handle('check-screen-recording-permission', async () => {
  if (process.platform !== 'darwin') {
    // Windows doesn't need screen recording permission for loopback audio
    return { status: 'granted', platform: process.platform };
  }

  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    console.log('[Sokuji] [Main] Screen recording permission status:', status);
    // Just return the raw status - don't try to trigger permission here
    // Calling desktopCapturer.getSources() would change 'not-determined' to 'denied'
    return { status, platform: 'darwin' };
  } catch (error) {
    console.error('[Sokuji] [Main] Error checking screen recording permission:', error);
    return { status: 'unknown', platform: 'darwin', error: error.message };
  }
});
