import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { Info, TriangleAlert } from 'lucide-react';
import type { ComponentProps } from 'react';

// DESIGN.md "Empty and Notice Blocks": pale tinted blocks for information and warnings, always with a text label.
// 12px control radius, Ink text at the 16px Body Floor. Info sits on Morning Mint (Ink on mint is 15.35:1).
// Departure recorded for review: DESIGN.md names no warning tint and forbids new hues and tokens, so the warn fill is the
// existing Amber Notice token at 10% alpha (`bg-warning/10`, a pale amber, not a new hue), with an Amber Notice border like
// the warning Tag. Text stays Ink, so contrast never depends on the tint.
const noticeVariants = cva('flex items-start gap-3 rounded-control border px-3.5 py-3 text-base text-ink', {
  variants: {
    tone: {
      info: 'border-transparent bg-accent-2',
      warn: 'border-warning bg-warning/10',
    },
  },
  defaultVariants: { tone: 'info' },
});

export type NoticeProps = ComponentProps<'div'> & VariantProps<typeof noticeVariants>;

/**
 * children is the message (the caller supplies the words; the primitive ships no copy). The tone is never colour alone:
 * an icon of a different shape plus the text carries it (DESIGN.md Second Signal Rule). info is role="status" (polite),
 * warn is role="alert" (assertive); a caller-supplied `role` replaces that default.
 */
export function Notice({ tone, role, className, children, ...props }: NoticeProps) {
  const resolved = tone ?? 'info';
  const Icon = resolved === 'warn' ? TriangleAlert : Info;
  return (
    <div
      {...props}
      role={role ?? (resolved === 'warn' ? 'alert' : 'status')}
      data-tone={resolved}
      className={clsx(noticeVariants({ tone }), className)}
    >
      {/* Ink on the mint tint; amber (4.5:1 on paper, above the 3:1 non-text floor) on the amber tint. */}
      <Icon aria-hidden="true" className={clsx('mt-0.5 size-5 shrink-0', resolved === 'warn' && 'text-warning')} />
      <div className="min-w-0 wrap-anywhere">{children}</div>
    </div>
  );
}
