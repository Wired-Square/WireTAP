// ui/src/components/Dialog.tsx

import { ReactNode } from 'react';
import { bgSurface } from "../styles";

export interface DialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when the backdrop is clicked (if onBackdropClick is not provided, this is a no-op) */
  onBackdropClick?: () => void;
  /** Dialog content */
  children: ReactNode;
  /** Optional custom width class (default: max-w-md) */
  maxWidth?: 'max-w-sm' | 'max-w-md' | 'max-w-lg' | 'max-w-xl' | 'max-w-2xl' | 'max-w-4xl' | 'max-w-7xl';
  /** Whether to add padding to the backdrop (default: true) */
  backdropPadding?: boolean;
}

/**
 * Base dialog component with consistent styling
 *
 * Provides:
 * - Fixed backdrop overlay with semi-transparent black background
 * - Centered dialog positioning
 * - White/dark mode support
 * - Optional backdrop click handling
 * - Customizable max-width
 *
 * @example
 * ```tsx
 * <Dialog isOpen={isOpen} onBackdropClick={onClose}>
 *   <div className="p-6">
 *     <h2>Dialog Title</h2>
 *     <p>Dialog content</p>
 *   </div>
 * </Dialog>
 * ```
 */
export default function Dialog({
  isOpen,
  onBackdropClick,
  children,
  maxWidth = 'max-w-md',
  backdropPadding = true,
}: DialogProps) {
  if (!isOpen) return null;

  // Use onMouseDown so that drag-selecting text that ends outside
  // the dialog doesn't dismiss it (mouseup on backdrop after mousedown
  // inside the dialog would otherwise fire onClick on the backdrop).
  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && onBackdropClick) {
      onBackdropClick();
    }
  };

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center z-50 ${
        backdropPadding ? 'p-4' : ''
      }`}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className={`${bgSurface} rounded-xl shadow-2xl ${maxWidth} w-full`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
