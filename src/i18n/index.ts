import { useStore } from "../state/store";
import { translate } from "./locales";

/** Returns a translator bound to the current display language. */
export function useT(): (key: string) => string {
  const lang = useStore((s) => s.settings["workbench.language"]);
  return (key: string) => translate(lang, key);
}
