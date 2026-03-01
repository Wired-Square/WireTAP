// ui/src/components/AppLayout.tsx
//
// Standardised outer layout component for apps. Provides consistent container
// structure with content margin for the bubble effect.

import { type ReactNode } from "react";
import { bgPrimary } from "../styles/colourTokens";
import { marginAppContent } from "../styles/spacing";

interface AppLayoutProps {
  /** Top bar content (rendered via AppTopBar or custom) */
  topBar: ReactNode;
  /** Main content */
  children: ReactNode;
  /** Add m-2 margin around content for bubble effect (default: true) */
  contentMargin?: boolean;
}

/**
 * Standardised outer layout component for apps.
 *
 * Provides:
 * - Full-height flex column container
 * - Theme-aware background (follows global theme setting)
 * - Optional margin around content for bubble effect
 *
 * @example
 * ```tsx
 * <AppLayout topBar={<AppTopBar icon={Search} ... />}>
 *   <AppTabView ...>
 *     {content}
 *   </AppTabView>
 * </AppLayout>
 * ```
 */
export default function AppLayout({
  topBar,
  children,
  contentMargin = true,
}: AppLayoutProps) {
  return (
    <div className={`h-full flex flex-col ${bgPrimary} overflow-hidden`}>
      {topBar}
      <div
        className={`flex-1 flex flex-col min-h-0 overflow-hidden ${contentMargin ? marginAppContent : ""}`}
      >
        {children}
      </div>
    </div>
  );
}
