import { useStore, type SidebarView } from "../state/store";
import { useT } from "../i18n";
import { Icon, type IconName } from "./Icon";

const VIEW_ITEMS: { view: SidebarView; icon: IconName; label: string }[] = [
  { view: "explorer", icon: "files", label: "activity.explorer" },
  { view: "search", icon: "search", label: "activity.search" },
  { view: "git", icon: "git", label: "activity.git" },
  { view: "gitGraph", icon: "graph", label: "activity.gitGraph" },
  { view: "debug", icon: "debug", label: "activity.debug" },
];

export function ActivityBar() {
  const t = useT();
  const sidebarView = useStore((s) => s.sidebarView);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const secondaryVisible = useStore((s) => s.secondaryVisible);
  const setSidebarView = useStore((s) => s.setSidebarView);
  const toggleSecondary = useStore((s) => s.toggleSecondary);
  const openSpecial = useStore((s) => s.openSpecial);

  return (
    <div className="activitybar">
      {VIEW_ITEMS.map((item) => (
        <button
          key={item.view}
          className={`activity-item ${
            sidebarVisible && sidebarView === item.view ? "active" : ""
          }`}
          title={t(item.label)}
          onClick={() => setSidebarView(item.view)}
        >
          <Icon name={item.icon} size={22} />
        </button>
      ))}
      <button
        className="activity-item"
        title={t("activity.extensions")}
        onClick={() => openSpecial("extensions")}
      >
        <Icon name="extensions" size={22} />
      </button>
      <button
        className={`activity-item ${secondaryVisible ? "active" : ""}`}
        title={t("activity.agent")}
        onClick={toggleSecondary}
      >
        <Icon name="agent" size={22} />
      </button>
      <div className="grow" />
      <button
        className="activity-item"
        title={t("activity.settings")}
        onClick={() => openSpecial("settings")}
      >
        <Icon name="settings" size={22} />
      </button>
    </div>
  );
}
