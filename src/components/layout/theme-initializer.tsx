"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { THEMES, applyTheme, storeThemeName } from "@/lib/themes";

/**
 * Mounts once at the app root to apply the Bodega One dark theme.
 *
 * NOTE: localStorage is intentionally bypassed for this release.
 * The "cabinet-theme" key may contain a stale value from before the
 * Bodega One fork (e.g. "paper"). Instead of trying to migrate stale
 * values we always boot to "bodega-one" and write it to localStorage
 * so the theme picker reflects the correct active theme.
 *
 * localStorage persistence for user theme choices can be re-enabled
 * once the theme picker is confirmed working in the Electron webview.
 */
export function ThemeInitializer() {
  const { setTheme } = useTheme();

  useEffect(() => {
    // Load Google Fonts for all themes
    if (!document.getElementById("theme-fonts-link")) {
      const link = document.createElement("link");
      link.id = "theme-fonts-link";
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=Bitter:wght@400;600;700&family=Bricolage+Grotesque:wght@400;600;700&family=Cormorant+Garamond:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&family=Figtree:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Instrument+Serif&family=Libre+Baskerville:wght@400;700&family=Merriweather+Sans:wght@400;500;600;700&family=Montserrat:wght@400;600;700&family=Nunito:wght@400;500;600;700&family=Orbitron:wght@400;600;700&family=Outfit:wght@400;500;600;700&family=Playfair+Display:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Quicksand:wght@400;500;600;700&family=Rubik:wght@400;500;600;700&family=Sora:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Spectral:wght@400;600;700&family=Syne:wght@400;600;700&family=Unbounded:wght@400;600;700&display=swap";
      document.head.appendChild(link);
    }

    // Always apply Bodega One — localStorage is bypassed this release
    const themeDef = THEMES.find((t) => t.name === "bodega-one") ?? THEMES[0];
    if (themeDef) {
      applyTheme(themeDef);
      setTheme(themeDef.type); // keeps next-themes in sync ("dark")
      storeThemeName(themeDef.name); // write so theme picker shows correct selection
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
