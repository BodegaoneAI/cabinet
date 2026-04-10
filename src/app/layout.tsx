import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeInitializer } from "@/components/layout/theme-initializer";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-logo",
  weight: "400",
  style: "italic",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cabinet",
  description: "AI-first knowledge base and startup OS",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Force dark class before first paint to prevent flash of light theme.
            Also detects Electron desktop context. Runs synchronously in <head>
            so it takes effect before any CSS is applied. */}
        <script dangerouslySetInnerHTML={{ __html: `document.documentElement.classList.add("dark");if(window.CabinetDesktop)document.documentElement.classList.add("electron-desktop");` }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          disableTransitionOnChange
        >
          <ThemeInitializer />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
