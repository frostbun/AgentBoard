"use client";

import { useEffect } from "react";

const HOLD_MS = 700;

/**
 * Marks the element being scrolled with `data-scrolling` for a moment, so the stylesheet can
 * show a scrollbar during movement and hide it again at rest (including when it is already at
 * the bottom, where a permanent bar is just noise).
 */
export function ScrollHider() {
  useEffect(() => {
    const timers = new WeakMap<Element, number>();
    const onScroll = (event: Event) => {
      const target = event.target;
      const element = target instanceof Element ? target : document.documentElement;
      if (!element.classList.contains("scroll-y")) return;
      element.setAttribute("data-scrolling", "true");
      const existing = timers.get(element);
      if (existing) window.clearTimeout(existing);
      timers.set(
        element,
        window.setTimeout(() => {
          element.removeAttribute("data-scrolling");
          timers.delete(element);
        }, HOLD_MS),
      );
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  return null;
}
