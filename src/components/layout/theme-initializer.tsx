"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import {
  THEMES,
  applyTheme,
  getStoredThemeName,
  storeThemeName,
} from "@/lib/themes";

/**
 * Mounts once at the app root to apply the correct custom theme CSS vars.
 *
 * Reads the user's saved choice from localStorage ("cabinet-theme-v2").
 * Falls back to THEMES[0] (Bodega One) when no value is stored — this
 * covers first-time loads and users migrating from older installs whose
 * stale "cabinet-theme" key is ignored by the versioned key change.
 *
 * applyTheme() handles both the CSS variable injection AND the dark/light
 * class toggle, keeping next-themes in sync via setTheme().
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

    // Read user's stored choice; fall back to the first theme (Bodega One)
    const stored = getStoredThemeName();
    const themeDef =
      (stored ? THEMES.find((t) => t.name === stored) : null) ?? THEMES[0];

    if (themeDef) {
      applyTheme(themeDef);           // sets CSS vars + toggles dark/light class
      setTheme(themeDef.type);        // keeps next-themes in sync
      storeThemeName(themeDef.name);  // persist (writes default if nothing stored)
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
