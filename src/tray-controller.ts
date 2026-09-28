import { Menu, Tray, app, globalShortcut, nativeImage } from "electron";

import { createTrayIconBuffer } from "./tray-icon";
import { HOTKEY_CANDIDATES, describeAccelerator } from "./tray";

export interface TrayControllerOptions {
  /** Bring the window up — creating it if needed — and focus the composer. */
  summon: () => void;
  /** Show it when hidden, hide it when shown. */
  toggle: () => void;
  isVisible: () => boolean;
  chooseVault: () => void;
  quit: () => void;
}

export interface TrayController {
  readonly hotkey: string;
  /** False when another app already owns the combination. */
  readonly hotkeyRegistered: boolean;
  refreshMenu(): void;
  notifyHidden(): void;
  dispose(): void;
}

/** Returns the accelerator that took effect, or null when all were taken. */
function registerFirstAvailableHotkey(summon: () => void): string | null {
  for (const candidate of HOTKEY_CANDIDATES) {
    if (globalShortcut.register(candidate, summon)) {
      return candidate;
    }
  }
  console.error("[tray] 全局快捷键注册失败，可能已被其它程序占用：", HOTKEY_CANDIDATES.join(" / "));
  return null;
}

/**
 * Keeps the shell reachable after the window is closed: a tray icon plus a
 * system-wide hotkey. The window is the expensive part (index sync, model
 * config, conversation state), so it is hidden rather than destroyed.
 */
export function createTrayController(options: TrayControllerOptions): TrayController {
  const hotkey = registerFirstAvailableHotkey(() => options.summon());
  const hotkeyLabel = hotkey ? describeAccelerator(hotkey) : "（快捷键被占用）";
  const tray = new Tray(nativeImage.createFromBuffer(createTrayIconBuffer()));
  tray.setToolTip("知识环");
  // Clicking the icon is a toggle on Windows/Linux. On macOS the click also
  // opens the menu, so toggling there would fight with it.
  if (process.platform !== "darwin") {
    tray.on("click", () => options.toggle());
  }

  let notifiedAboutTray = false;

  const refreshMenu = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: options.isVisible() ? "隐藏窗口" : "显示窗口",
          click: () => options.toggle()
        },
        { label: "打开其他知识库…", click: () => options.chooseVault() },
        { type: "separator" },
        {
          label: "开机自启动",
          type: "checkbox",
          // Read back from the OS rather than a config file: the user can also
          // change it in Task Manager / System Settings, and a stale copy here
          // would show a checkbox that lies.
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
        },
        { type: "separator" },
        { label: `按 ${hotkeyLabel} 唤起`, enabled: false },
        { type: "separator" },
        { label: "退出知识环", click: () => options.quit() }
      ])
    );
  };

  refreshMenu();

  return {
    hotkey: hotkey ?? "",
    hotkeyRegistered: Boolean(hotkey),
    refreshMenu,
    notifyHidden(): void {
      if (notifiedAboutTray) {
        return;
      }
      notifiedAboutTray = true;
      // Windows only; silently does nothing elsewhere. Worth it because hiding
      // on close is surprising the first time — otherwise the app looks like it
      // simply vanished.
      tray.displayBalloon({
        title: "知识环仍在后台运行",
        content: `按 ${hotkeyLabel} 随时唤起，或在托盘图标上右键退出。`
      });
    },
    dispose(): void {
      globalShortcut.unregisterAll();
      tray.destroy();
    }
  };
}
