import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { JSX } from "react";

export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      storageKey="ai-intern-theme"
      themes={["dark", "light"]}
    >
      {children}
    </NextThemesProvider>
  );
}

export { useTheme };
