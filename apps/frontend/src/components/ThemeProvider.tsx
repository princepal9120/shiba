import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { ComponentProps, JSX, ReactNode } from "react";

// ponytail: next-themes@0.4.6 types drop `children` under @types/react 19.2 (PropsWithChildren<unknown> extends bug). Remove cast when fixed upstream.
const Provider = NextThemesProvider as (
  props: ComponentProps<typeof NextThemesProvider> & { children?: ReactNode },
) => JSX.Element;

export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Provider
      attribute="class"
      defaultTheme="light"
      enableSystem
      storageKey="shiba-ai-coworker-theme"
      themes={["dark", "light"]}
    >
      {children}
    </Provider>
  );
}

export { useTheme };
