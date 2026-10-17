// electron/tray.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const electronPath = nodeRequire.resolve('electron');
const trayModulePath = nodeRequire.resolve('./tray.js');
const quickTranslateModulePath = nodeRequire.resolve('./quick-translate.js');

describe('electron/tray.js', () => {
  let fakeTrayInstance;
  let fakeMenuTemplate;
  let fakeApp;
  let fakeMainWindow;
  let fakeQuickTranslate;

  beforeEach(() => {
    fakeMenuTemplate = [];
    fakeTrayInstance = {
      destroyed: false,
      toolTip: '',
      contextMenu: null,
      listeners: {},
      setToolTip: vi.fn(function (tip) {
        this.toolTip = tip;
      }),
      setContextMenu: vi.fn(function (menu) {
        this.contextMenu = menu;
      }),
      destroy: vi.fn(function () {
        this.destroyed = true;
      }),
      on: vi.fn(function (event, cb) {
        this.listeners[event] = cb;
      }),
      popUpContextMenu: vi.fn(),
      isDestroyed: vi.fn(function () {
        return this.destroyed;
      }),
    };

    fakeApp = {
      isQuitting: false,
      getVersion: () => '1.0.25',
      getAppPath: () => '/mock/app',
      quit: vi.fn(),
      focus: vi.fn(),
    };

    fakeMainWindow = {
      destroyed: false,
      visible: false,
      minimized: false,
      isVisible: vi.fn(function () {
        return this.visible;
      }),
      isDestroyed: vi.fn(function () {
        return this.destroyed;
      }),
      isMinimized: vi.fn(function () {
        return this.minimized;
      }),
      show: vi.fn(function () {
        this.visible = true;
      }),
      hide: vi.fn(function () {
        this.visible = false;
      }),
      restore: vi.fn(function () {
        this.minimized = false;
      }),
      focus: vi.fn(),
      webContents: {
        send: vi.fn(),
      },
      on: vi.fn(),
    };

    fakeQuickTranslate = {
      captureSelectedText: vi.fn().mockResolvedValue('Mock selected text'),
      captureScreenshotAndOcr: vi.fn().mockResolvedValue({ text: 'Mock OCR text' }),
      showQuickTranslate: vi.fn(),
      checkAccessibilityPermission: vi.fn().mockReturnValue(true),
    };

    const fakeElectron = {
      app: fakeApp,
      Tray: vi.fn(function () {
        return fakeTrayInstance;
      }),
      Menu: {
        buildFromTemplate: vi.fn((template) => {
          fakeMenuTemplate = template;
          return { items: template };
        }),
      },
      nativeImage: {
        createFromPath: vi.fn(() => ({
          isEmpty: () => false,
          getSize: () => ({ width: 20, height: 20 }),
          resize: vi.fn(() => ({
            setTemplateImage: vi.fn(),
          })),
        })),
        createEmpty: vi.fn(() => ({})),
      },
      clipboard: {
        readText: vi.fn(() => 'Mock clipboard text'),
      },
      dialog: {
        showMessageBox: vi.fn(),
      },
      systemPreferences: {
        isTrustedAccessibilityClient: () => true,
      },
    };

    nodeRequire.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: fakeElectron,
    };

    nodeRequire.cache[quickTranslateModulePath] = {
      id: quickTranslateModulePath,
      filename: quickTranslateModulePath,
      loaded: true,
      exports: fakeQuickTranslate,
    };

    delete nodeRequire.cache[trayModulePath];
  });

  afterEach(() => {
    delete nodeRequire.cache[electronPath];
    delete nodeRequire.cache[quickTranslateModulePath];
    delete nodeRequire.cache[trayModulePath];
  });

  it('creates tray and sets tooltip and context menu', () => {
    const { setupTray } = nodeRequire(trayModulePath);
    const tray = setupTray(() => fakeMainWindow);

    expect(tray).toBe(fakeTrayInstance);
    expect(fakeTrayInstance.setToolTip).toHaveBeenCalledWith('MAO Chat');
    expect(fakeTrayInstance.setContextMenu).toHaveBeenCalled();
  });

  it('contains expected translation and app controls in menu', () => {
    const { setupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    const labels = fakeMenuTemplate.map((item) => item.label).filter(Boolean);
    expect(labels).toContain('划词翻译');
    expect(labels).toContain('截图翻译');
    expect(labels).toContain('剪贴板翻译');
    expect(labels).toContain('显示翻译窗口');
    expect(labels).toContain('打开主界面');
    expect(labels).toContain('偏好设置...');
    expect(labels).toContain('MAO Chat v1.0.25');
    expect(labels).toContain('退出');
  });

  it('switches between 打开主界面 and 隐藏主界面 depending on window visibility', () => {
    fakeMainWindow.visible = false;
    const { setupTray, updateTrayMenu } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    let mainToggleItem = fakeMenuTemplate.find((item) => item.label?.includes('主界面'));
    expect(mainToggleItem.label).toBe('打开主界面');

    // Simulate clicking "打开主界面"
    mainToggleItem.click();
    expect(fakeMainWindow.show).toHaveBeenCalled();
    expect(fakeMainWindow.focus).toHaveBeenCalled();

    // Now window is visible
    fakeMainWindow.visible = true;
    updateTrayMenu();
    mainToggleItem = fakeMenuTemplate.find((item) => item.label?.includes('主界面'));
    expect(mainToggleItem.label).toBe('隐藏主界面');

    // Simulate clicking "隐藏主界面"
    mainToggleItem.click();
    expect(fakeMainWindow.hide).toHaveBeenCalled();
  });

  it('triggers selection capture and quick translate when clicking 划词翻译', async () => {
    const { setupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    const selectItem = fakeMenuTemplate.find((item) => item.label === '划词翻译');
    expect(selectItem).toBeDefined();

    await selectItem.click();
    expect(fakeQuickTranslate.captureSelectedText).toHaveBeenCalledWith(fakeMainWindow);
    expect(fakeQuickTranslate.showQuickTranslate).toHaveBeenCalledWith(
      'Mock selected text',
      'selection',
      fakeMainWindow,
    );
  });

  it('triggers screenshot OCR and quick translate when clicking 截图翻译', async () => {
    const { setupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    const screenshotItem = fakeMenuTemplate.find((item) => item.label === '截图翻译');
    expect(screenshotItem).toBeDefined();

    await screenshotItem.click();
    expect(fakeQuickTranslate.captureScreenshotAndOcr).toHaveBeenCalledWith({
      parentWindow: fakeMainWindow,
    });
    expect(fakeQuickTranslate.showQuickTranslate).toHaveBeenCalledWith(
      'Mock OCR text',
      'screenshot',
      fakeMainWindow,
    );
  });

  it('triggers clipboard translate when clicking 剪贴板翻译', () => {
    const { setupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    const clipItem = fakeMenuTemplate.find((item) => item.label === '剪贴板翻译');
    expect(clipItem).toBeDefined();

    clipItem.click();
    expect(fakeQuickTranslate.showQuickTranslate).toHaveBeenCalledWith(
      'Mock clipboard text',
      'clipboard',
      fakeMainWindow,
    );
  });

  it('opens empty quick translate window when clicking 显示翻译窗口', () => {
    const { setupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    const manualItem = fakeMenuTemplate.find((item) => item.label === '显示翻译窗口');
    expect(manualItem).toBeDefined();

    manualItem.click();
    expect(fakeQuickTranslate.showQuickTranslate).toHaveBeenCalledWith(
      '',
      'manual',
      fakeMainWindow,
    );
  });

  it('opens preferences and sends menu:open-settings when clicking 偏好设置...', () => {
    const { setupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    const prefItem = fakeMenuTemplate.find((item) => item.label === '偏好设置...');
    expect(prefItem).toBeDefined();

    prefItem.click();
    expect(fakeMainWindow.show).toHaveBeenCalled();
    expect(fakeMainWindow.focus).toHaveBeenCalled();
    expect(fakeMainWindow.webContents.send).toHaveBeenCalledWith('menu:open-settings');
  });

  it('quits application when clicking 退出', () => {
    const { setupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    const quitItem = fakeMenuTemplate.find((item) => item.label === '退出');
    expect(quitItem).toBeDefined();

    quitItem.click();
    expect(fakeApp.isQuitting).toBe(true);
    expect(fakeApp.quit).toHaveBeenCalled();
  });

  it('cleans up tray on cleanupTray()', () => {
    const { setupTray, cleanupTray } = nodeRequire(trayModulePath);
    setupTray(() => fakeMainWindow);

    cleanupTray();
    expect(fakeTrayInstance.destroy).toHaveBeenCalled();
  });
});
