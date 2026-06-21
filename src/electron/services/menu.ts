import {
  app,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { CH } from "../../shared/channels";
import type { MenuAction } from "../../shared/types";
import type { ServiceContext } from "./context";

/**
 * Builds the NATIVE application menu (macOS menubar / Windows-Linux window menu)
 * with Electron's own `Menu.buildFromTemplate` + `Menu.setApplicationMenu`. It is
 * a real OS menu, not an in-DOM one.
 *
 * Two kinds of items:
 *  - Role items (undo/copy/zoom/reload/quit/…) are handled natively by Electron.
 *  - Custom items dispatch a typed `MenuAction` to the renderer over CH.menuAction;
 *    the renderer (App.tsx) routes each to a store action or window event.
 *
 * Accelerator policy: the renderer already binds ⌘P / ⌘B / ⌘J / ⌘, (see App.tsx),
 * so those menu items intentionally carry NO accelerator — adding one risks the
 * key firing both natively and in the renderer. Items the renderer does NOT bind
 * (New File, Open, Save, Close, New Terminal) get accelerators here.
 */
export function registerMenu(ctx: ServiceContext): () => void {
  const isMac = process.platform === "darwin";
  const send = (action: MenuAction) => ctx.send(CH.menuAction, action);

  const macAppMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: "Settings…",
              accelerator: "Cmd+,",
              click: () => send("settings.open"),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...macAppMenu,
    {
      label: "File",
      submenu: [
        {
          label: "New File…",
          accelerator: "CmdOrCtrl+N",
          click: () => send("file.new"),
        },
        { type: "separator" },
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: () => send("file.openFolder"),
        },
        {
          label: "Open File…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => send("file.openFile"),
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => send("file.save"),
        },
        {
          label: "Close Editor",
          accelerator: "CmdOrCtrl+W",
          click: () => send("file.closeEditor"),
        },
        ...(isMac
          ? []
          : ([
              { type: "separator" },
              {
                label: "Settings",
                accelerator: "Ctrl+,",
                click: () => send("settings.open"),
              },
              { type: "separator" },
              { role: "quit" },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...((isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ]
          : [
              { role: "delete" },
              { type: "separator" },
              { role: "selectAll" },
            ]) as MenuItemConstructorOptions[]),
      ],
    },
    {
      label: "View",
      submenu: [
        // No accelerator — renderer binds ⌘P (App.tsx keydown).
        { label: "Command Palette…", click: () => send("view.commandPalette") },
        { type: "separator" },
        { label: "Explorer", click: () => send("view.explorer") },
        { label: "Search", click: () => send("view.search") },
        { label: "Source Control", click: () => send("view.git") },
        { label: "Agent", click: () => send("view.agent") },
        { type: "separator" },
        // No accelerators — renderer binds ⌘B / ⌘J.
        { label: "Toggle Sidebar", click: () => send("view.toggleSidebar") },
        { label: "Toggle Panel", click: () => send("view.togglePanel") },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Git",
      submenu: [
        { label: "Commit", click: () => send("git.commit") },
        { type: "separator" },
        { label: "Pull", click: () => send("git.pull") },
        { label: "Push", click: () => send("git.push") },
        { label: "Sync", click: () => send("git.sync") },
        { label: "Fetch", click: () => send("git.fetch") },
        { type: "separator" },
        { label: "Refresh", click: () => send("git.refresh") },
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          label: "New Terminal",
          accelerator: "CmdOrCtrl+Shift+`",
          click: () => send("terminal.new"),
        },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "About Logos", click: () => send("help.about") },
        {
          label: "Documentation",
          click: () =>
            void shell.openExternal("https://github.com/zixiao-labs/logos"),
        },
        {
          label: "Report Issue",
          click: () =>
            void shell.openExternal(
              "https://github.com/zixiao-labs/logos/issues",
            ),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  return () => {
    Menu.setApplicationMenu(null);
  };
}
