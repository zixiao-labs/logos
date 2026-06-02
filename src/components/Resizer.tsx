import { useRef } from "react";

interface ResizerProps {
  orientation: "vertical" | "horizontal";
  /** Called with the incremental delta (px) as the user drags. */
  onResize: (delta: number) => void;
  /** Invert the delta sign (e.g. handle on the left edge of a right panel). */
  invert?: boolean;
}

export function Resizer({ orientation, onResize, invert }: ResizerProps) {
  const last = useRef(0);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const axis = orientation === "vertical" ? "clientX" : "clientY";
    last.current = e[axis];

    const move = (ev: MouseEvent) => {
      const cur = ev[axis];
      let delta = cur - last.current;
      if (invert) delta = -delta;
      last.current = cur;
      onResize(delta);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor =
      orientation === "vertical" ? "col-resize" : "row-resize";
  }

  return (
    <div className={`resizer ${orientation}`} onMouseDown={onMouseDown} />
  );
}
