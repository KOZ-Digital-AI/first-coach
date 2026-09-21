import { clsx } from 'clsx';
import type { ComponentProps } from 'react';

/**
 * Decorative loading placeholder: a Chalk Line block at the 12px control radius. It sets no size of its own, so callers
 * pass h-*, w-* or size-* through className. It is hidden from assistive tech; the loading state itself is announced by
 * the caller (aria-busy on the region), never by this block. The pulse stops under prefers-reduced-motion.
 */
export function Skeleton({ className, ...props }: Omit<ComponentProps<'div'>, 'children'>) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={clsx('max-w-full animate-pulse rounded-control bg-line motion-reduce:animate-none', className)}
    />
  );
}
