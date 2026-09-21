import { clsx } from 'clsx';
import type { ComponentProps, ReactNode } from 'react';

export type EmptyStateProps = Omit<ComponentProps<'div'>, 'title' | 'children'> & {
  /** Short, calm statement of what is empty. Rendered as a paragraph, not a heading: the caller owns heading levels. */
  title: ReactNode;
  /** One encouraging next step in plain words; never blames the user. */
  hint: ReactNode;
  /** Optional next-step control (a Button, a link). Nothing at all is rendered for it when omitted. */
  action?: ReactNode;
};

/*
 * DESIGN.md "Empty and Notice Blocks": dashed Chalk Line border with muted, encouraging copy, 18px card radius. Left-aligned
 * so long Kazakh and Russian lines stay easy to read; the hint stays at the 16px body floor. Text may break anywhere
 * (wrap-anywhere) so a long word never pushes the block past 360px. Text only: no icon, so nothing needs a second signal.
 */
export function EmptyState({ title, hint, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      {...props}
      className={clsx(
        'flex min-w-0 flex-col items-start gap-2 rounded-card border border-dashed border-line p-5.5 wrap-anywhere',
        className,
      )}
    >
      <p className="text-xl leading-tight font-bold tracking-tight text-ink">{title}</p>
      <p className="text-base text-muted">{hint}</p>
      {action ? <div className="mt-2 max-w-full">{action}</div> : null}
    </div>
  );
}
