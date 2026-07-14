import type { SidebarView } from "../state/store";
import { Explorer } from "./Explorer";
import { SearchPanel } from "./SearchPanel";
import { GitPanel } from "./GitPanel";
import { DebugSidebar } from "./DebugSidebar";

/** Renders the inner view for a primary side-bar slot. */
export function SideContent({ view }: { view: SidebarView }) {
  switch (view) {
    case "search":
      return <SearchPanel />;
    case "git":
      return <GitPanel />;
    case "debug":
      return <DebugSidebar />;
    case "explorer":
    default:
      return <Explorer />;
  }
}
