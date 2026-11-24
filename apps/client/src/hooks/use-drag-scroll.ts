/**
 * Lets a horizontal scroller be dragged left/right with a mouse or pen, the
 * same way a finger swipes it on touch screens (touch keeps native, momentum
 * scrolling). A drag longer than a few pixels doesn't count as a click, so
 * dragging across a link doesn't open it.
 */
import { useEffect, type RefObject } from "react";

const THRESHOLD = 5; // px of movement before a press becomes a drag

/**
 * @param active Pass whether the scroller is rendered, so the listeners are
 *               attached once it mounts (e.g. after its data loads).
 */
export function useDragScroll(
  ref: RefObject<HTMLElement | null>,
  active = true,
) {
  useEffect(() => {
    const el = ref.current;

    if (!el || !active) return;

    let startX = 0;
    let startScroll = 0;
    let pointerId: number | null = null;
    let dragged = false;

    const onDown = (e: PointerEvent) => {
      // Touch already scrolls natively; only the primary mouse/pen button drags.
      if (e.pointerType === "touch" || e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      dragged = false;
    };

    const onMove = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      const dx = e.clientX - startX;

      if (!dragged) {
        if (Math.abs(dx) < THRESHOLD) return;
        dragged = true;
        el.setPointerCapture(e.pointerId);
        // Snapping and smooth scrolling fight a drag: turn them off meanwhile.
        el.style.scrollSnapType = "none";
        el.style.scrollBehavior = "auto";
        el.style.cursor = "grabbing";
        el.style.userSelect = "none";
      }
      el.scrollLeft = startScroll - dx;
    };

    const onUp = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      if (!dragged) return;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      el.style.scrollSnapType = "";
      el.style.scrollBehavior = "";
      el.style.cursor = "";
      el.style.userSelect = "";
    };

    // Swallow the click that ends a drag, so links/buttons under it don't fire.
    const onClick = (e: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      e.preventDefault();
      e.stopPropagation();
    };

    // Stop the browser's native image/link drag from hijacking the gesture.
    const onDragStart = (e: DragEvent) => e.preventDefault();

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    el.addEventListener("dragstart", onDragStart);

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("dragstart", onDragStart);
    };
  }, [ref, active]);
}
