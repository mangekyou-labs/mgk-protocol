import type { ReactNode } from 'react';

export interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  return (
    <div data-testid="theme-provider-root" data-theme="dark" className="mgk-theme-root flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );
}
