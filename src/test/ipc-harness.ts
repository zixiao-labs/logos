import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;
type EventHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

export function createIpcHarness() {
  const handlers = new Map<string, InvokeHandler>();
  const listeners = new Map<string, EventHandler>();
  const ipcMain = {
    handle(channel: string, handler: InvokeHandler) {
      handlers.set(channel, handler);
    },
    on(channel: string, listener: EventHandler) {
      listeners.set(channel, listener);
      return ipcMain;
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;

  return {
    ipcMain,
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
      return (await handler({} as IpcMainInvokeEvent, ...args)) as T;
    },
    emit(channel: string, ...args: unknown[]): void {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`No IPC listener registered for ${channel}`);
      listener({} as IpcMainEvent, ...args);
    },
  };
}
