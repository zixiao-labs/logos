import { useEffect, useRef } from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onClick: () => void;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - items.length * 30 - 12),
        zIndex: 200,
        minWidth: 200,
        background: "var(--overlay)",
        color: "var(--overlay-foreground)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
        padding: 4,
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div
            key={i}
            style={{
              height: 1,
              background: "var(--separator)",
              margin: "4px 0",
            }}
          />
        ) : (
          <button
            key={i}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              border: "none",
              background: "transparent",
              color: item.danger ? "var(--danger)" : "inherit",
              padding: "6px 10px",
              borderRadius: 6,
              fontSize: 13,
              textAlign: "left",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "var(--surface-secondary)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            {item.icon && <Icon name={item.icon} size={15} />}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
