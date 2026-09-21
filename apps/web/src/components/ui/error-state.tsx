import { clsx } from 'clsx';
import { CircleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from './button';

export type ErrorStateProps = Omit<ComponentProps<'div'>, 'title' | 'children' | 'role'> & {
  /** What went wrong, in plain words. Rendered as a paragraph, not a heading: the caller owns heading levels. */
  title: ReactNode;
  /** The recovery, in plain words; never blames the user. */
  message: ReactNode;
  /** Called when the (enabled) Retry button is clicked. */
  onRetry: () => void;
  /** While true the Retry button is natively disabled, aria-busy and shows a spinner beside its label. */
  retrying?: boolean;
  /** Visible, translated label of the Retry button. Required: the primitive holds no strings of its own. */
  retryLabel: string;
};

/*
 * Announced as a whole via role="alert". DESIGN.md Colors > Semantic: Signal Red is for errors and is always paired with
 * words and an icon, so the decorative CircleAlert (aria-hidden) sits beside the title text and the border is red only as
 * a secondary cue. Ink title and muted message keep contrast (title ink on paper 17.88:1, muted 4.99:1); the icon is the
 * only red element that carries no text. On phones the Retry button spans the width for a thumb; from the sm breakpoint it hugs its label.
 *
 * Focus: a natively disabled button can drop keyboard focus. A caller that sets `retrying` from the Retry click owns
 * restoring focus (to this button, or to the content that replaces it) when the retry settles.
 */
export function ErrorState({ title, message, onRetry, retrying = false, retryLabel, className, ...props }: ErrorStateProps) {
  return (
    <div
      {...props}
      role="alert"
      className={clsx(
        'flex min-w-0 flex-col items-start gap-2 rounded-card border border-danger bg-paper p-5.5 text-ink wrap-anywhere',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert aria-hidden="true" className="size-6 shrink-0 text-danger" />
        <p className="min-w-0 text-xl leading-tight font-bold tracking-tight">{title}</p>
      </div>
      <p className="text-base text-muted">{message}</p>
      <Button className="mt-2 w-full sm:w-auto" loading={retrying} onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
