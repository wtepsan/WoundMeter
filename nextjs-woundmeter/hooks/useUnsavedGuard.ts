"use client";

import { useEffect, useRef } from "react";

import { setUnsaved } from "@/lib/navigation-guard";

/** While `unsaved` is true, leaving the screen asks first: in the app, and when closing or reloading the page. */
export function useUnsavedGuard(unsaved: boolean) {
  const key = useRef(Symbol("unsaved"));
  useEffect(() => {
    const id = key.current;
    setUnsaved(id, unsaved);
    if (!unsaved) return () => setUnsaved(id, false);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      setUnsaved(id, false);
    };
  }, [unsaved]);
}
