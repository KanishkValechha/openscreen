import { ipcMain as n, screen as j, BrowserWindow as _, desktopCapturer as C, shell as U, app as u, dialog as D, nativeImage as M, Tray as A, Menu as z } from "electron";
import { fileURLToPath as O } from "node:url";
import o from "node:path";
import R from "node:fs/promises";
const I = o.dirname(O(import.meta.url)), H = o.join(I, ".."), g = process.env.VITE_DEV_SERVER_URL, b = o.join(H, "dist");
let w = null;
n.on("hud-overlay-hide", () => {
  w && !w.isDestroyed() && w.minimize();
});
function q() {
  const a = j.getPrimaryDisplay(), { workArea: t } = a, d = 500, p = 100, v = Math.floor(t.x + (t.width - d) / 2), h = Math.floor(t.y + t.height - p - 5), c = new _({
    width: d,
    height: p,
    minWidth: 500,
    maxWidth: 500,
    minHeight: 100,
    maxHeight: 100,
    x: v,
    y: h,
    frame: !1,
    transparent: !0,
    resizable: !1,
    alwaysOnTop: !0,
    skipTaskbar: !0,
    hasShadow: !1,
    webPreferences: {
      preload: o.join(I, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0,
      backgroundThrottling: !1
    }
  });
  return c.webContents.on("did-finish-load", () => {
    c == null || c.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), w = c, c.on("closed", () => {
    w === c && (w = null);
  }), g ? c.loadURL(g + "?windowType=hud-overlay") : c.loadFile(o.join(b, "index.html"), {
    query: { windowType: "hud-overlay" }
  }), c;
}
function B() {
  const a = process.platform === "darwin", t = new _({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...a && {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 }
    },
    transparent: !1,
    resizable: !0,
    alwaysOnTop: !1,
    skipTaskbar: !1,
    title: "OpenScreen",
    backgroundColor: "#000000",
    webPreferences: {
      preload: o.join(I, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0,
      webSecurity: !1,
      backgroundThrottling: !1
    }
  });
  return t.maximize(), t.webContents.on("did-finish-load", () => {
    t == null || t.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), g ? t.loadURL(g + "?windowType=editor") : t.loadFile(o.join(b, "index.html"), {
    query: { windowType: "editor" }
  }), t;
}
function N() {
  const { width: a, height: t } = j.getPrimaryDisplay().workAreaSize, d = new _({
    width: 620,
    height: 420,
    minHeight: 350,
    maxHeight: 500,
    x: Math.round((a - 620) / 2),
    y: Math.round((t - 420) / 2),
    frame: !1,
    resizable: !1,
    alwaysOnTop: !0,
    transparent: !0,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: o.join(I, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0
    }
  });
  return g ? d.loadURL(g + "?windowType=source-selector") : d.loadFile(o.join(b, "index.html"), {
    query: { windowType: "source-selector" }
  }), d;
}
let T = null;
function G(a, t, d, p, v) {
  n.handle("get-sources", async (e, s) => (await C.getSources(s)).map((r) => ({
    id: r.id,
    name: r.name,
    display_id: r.display_id,
    thumbnail: r.thumbnail ? r.thumbnail.toDataURL() : null,
    appIcon: r.appIcon ? r.appIcon.toDataURL() : null
  }))), n.handle("select-source", (e, s) => {
    T = s;
    const l = p();
    return l && l.close(), T;
  }), n.handle("get-selected-source", () => T), n.handle("open-source-selector", () => {
    const e = p();
    if (e) {
      e.focus();
      return;
    }
    t();
  }), n.handle("switch-to-editor", () => {
    const e = d();
    e && e.close(), a();
  }), n.handle("store-recorded-video", async (e, s, l) => {
    try {
      const r = o.join(f, l);
      return await R.writeFile(r, Buffer.from(s)), h = r, {
        success: !0,
        path: r,
        message: "Video stored successfully"
      };
    } catch (r) {
      return console.error("Failed to store video:", r), {
        success: !1,
        message: "Failed to store video",
        error: String(r)
      };
    }
  }), n.handle("get-recorded-video-path", async () => {
    try {
      const s = (await R.readdir(f)).filter((S) => S.endsWith(".webm"));
      if (s.length === 0)
        return { success: !1, message: "No recorded video found" };
      const l = s.sort().reverse()[0];
      return { success: !0, path: o.join(f, l) };
    } catch (e) {
      return console.error("Failed to get video path:", e), { success: !1, message: "Failed to get video path", error: String(e) };
    }
  }), n.handle("set-recording-state", (e, s) => {
    v && v(s, (T || { name: "Screen" }).name);
  }), n.handle("open-external-url", async (e, s) => {
    try {
      return await U.openExternal(s), { success: !0 };
    } catch (l) {
      return console.error("Failed to open URL:", l), { success: !1, error: String(l) };
    }
  }), n.handle("get-asset-base-path", () => {
    try {
      return u.isPackaged ? o.join(process.resourcesPath, "assets") : o.join(u.getAppPath(), "public", "assets");
    } catch (e) {
      return console.error("Failed to resolve asset base path:", e), null;
    }
  }), n.handle("save-exported-video", async (e, s, l) => {
    try {
      const r = l.toLowerCase().endsWith(".gif"), S = r ? [{ name: "GIF Image", extensions: ["gif"] }] : [{ name: "MP4 Video", extensions: ["mp4"] }], P = await D.showSaveDialog({
        title: r ? "Save Exported GIF" : "Save Exported Video",
        defaultPath: o.join(u.getPath("downloads"), l),
        filters: S,
        properties: ["createDirectory", "showOverwriteConfirmation"]
      });
      return P.canceled || !P.filePath ? {
        success: !1,
        cancelled: !0,
        message: "Export cancelled"
      } : (await R.writeFile(P.filePath, Buffer.from(s)), {
        success: !0,
        path: P.filePath,
        message: "Video exported successfully"
      });
    } catch (r) {
      return console.error("Failed to save exported video:", r), {
        success: !1,
        message: "Failed to save exported video",
        error: String(r)
      };
    }
  }), n.handle("open-video-file-picker", async () => {
    try {
      const e = await D.showOpenDialog({
        title: "Select Video File",
        defaultPath: f,
        filters: [
          { name: "Video Files", extensions: ["webm", "mp4", "mov", "avi", "mkv"] },
          { name: "All Files", extensions: ["*"] }
        ],
        properties: ["openFile"]
      });
      return e.canceled || e.filePaths.length === 0 ? { success: !1, cancelled: !0 } : {
        success: !0,
        path: e.filePaths[0]
      };
    } catch (e) {
      return console.error("Failed to open file picker:", e), {
        success: !1,
        message: "Failed to open file picker",
        error: String(e)
      };
    }
  });
  let h = null;
  n.handle("set-current-video-path", (e, s) => (h = s, { success: !0 })), n.handle("get-current-video-path", () => h ? { success: !0, path: h } : { success: !1 }), n.handle("clear-current-video-path", () => (h = null, { success: !0 })), n.handle("get-platform", () => process.platform);
  let c = {
    screenAudio: !0,
    micEnabled: !0,
    micDeviceId: ""
  };
  n.handle("save-audio-preferences", (e, s) => (c = s, { success: !0 })), n.handle("get-audio-preferences", () => c);
}
const $ = o.dirname(O(import.meta.url)), f = o.join(u.getPath("userData"), "recordings");
async function Q() {
  try {
    await R.mkdir(f, { recursive: !0 }), console.log("RECORDINGS_DIR:", f), console.log("User Data Path:", u.getPath("userData"));
  } catch (a) {
    console.error("Failed to create recordings directory:", a);
  }
}
process.env.APP_ROOT = o.join($, "..");
const J = process.env.VITE_DEV_SERVER_URL, oe = o.join(process.env.APP_ROOT, "dist-electron"), V = o.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = J ? o.join(process.env.APP_ROOT, "public") : V;
let i = null, y = null, m = null, W = "";
const k = L("openscreen.png"), K = L("rec-button.png");
function E() {
  i = q();
}
function x() {
  m = new A(k);
}
function L(a) {
  return M.createFromPath(o.join(process.env.VITE_PUBLIC || V, a)).resize({
    width: 24,
    height: 24,
    quality: "best"
  });
}
function F(a = !1) {
  if (!m) return;
  const t = a ? K : k, d = a ? `Recording: ${W}` : "OpenScreen", p = a ? [
    {
      label: "Stop Recording",
      click: () => {
        i && !i.isDestroyed() && i.webContents.send("stop-recording-from-tray");
      }
    }
  ] : [
    {
      label: "Open",
      click: () => {
        i && !i.isDestroyed() ? i.isMinimized() && i.restore() : E();
      }
    },
    {
      label: "Quit",
      click: () => {
        u.quit();
      }
    }
  ];
  m.setImage(t), m.setToolTip(d), m.setContextMenu(z.buildFromTemplate(p));
}
function X() {
  i && (i.close(), i = null), i = B();
}
function Y() {
  return y = N(), y.on("closed", () => {
    y = null;
  }), y;
}
u.on("window-all-closed", () => {
});
u.on("activate", () => {
  _.getAllWindows().length === 0 && E();
});
u.whenReady().then(async () => {
  const { ipcMain: a } = await import("electron");
  a.on("hud-overlay-close", () => {
    u.quit();
  }), x(), F(), await Q(), G(
    X,
    Y,
    () => i,
    () => y,
    (t, d) => {
      W = d, m || x(), F(t), t || i && i.restore();
    }
  ), E();
});
export {
  oe as MAIN_DIST,
  f as RECORDINGS_DIR,
  V as RENDERER_DIST,
  J as VITE_DEV_SERVER_URL
};
