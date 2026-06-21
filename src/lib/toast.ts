import { toast } from "@heroui/react";

/**
 * Thin wrapper around HeroUI's `toast` so call sites stay terse and consistent.
 * Mount `<Toast.Provider />` once (see App.tsx) for these to render.
 */

export function notify(message: string, description?: string): void {
  toast(message, description ? { description } : undefined);
}

export function notifySuccess(message: string, description?: string): void {
  toast.success(message, description ? { description } : undefined);
}

export function notifyError(message: string, description?: string): void {
  toast.danger(message, description ? { description } : undefined);
}

export function notifyInfo(message: string, description?: string): void {
  toast.info(message, description ? { description } : undefined);
}

/**
 * Surface a human-readable result string from a Git command. The git service
 * returns plain summaries like "Pushed", "Synced", or "Push failed: …"; pick the
 * variant by sniffing for failure language so the user always gets feedback.
 */
export function notifyResult(message: string, fallbackTitle?: string): void {
  const text = message?.trim() || fallbackTitle || "Done";
  if (/\b(fail|failed|error|rejected|denied)\b/i.test(text)) {
    toast.danger(text);
  } else {
    toast.success(text);
  }
}

export { toast };
