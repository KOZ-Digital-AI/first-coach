import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import type { ComponentProps } from 'react';

// DESIGN.md "Skill Pills and Tags": pill radius, 12px bold label, 6px 9px padding. Long Kazakh/Russian labels wrap inside
// the pill (max-w-full + wrap-anywhere) rather than stretching past 360px.
const tagVariants = cva(
  'inline-flex max-w-full items-center gap-1.5 rounded-pill border px-2.25 py-1.5 text-xs leading-tight font-bold wrap-anywhere',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-bg text-ink',
        // Ink, not Field Green, on Morning Mint: green on mint is only 4.28:1 (DESIGN.md departure 3).
        accent: 'border-transparent bg-accent-2 text-ink',
        // Amber measures 4.53:1 on paper but only 4.12:1 on Bench Paper, so the warning tag sits on a paper fill.
        warning: 'border-warning bg-paper text-warning',
        // Known DESIGN.md gap: Signal Red on the danger tint is 4.28:1, below AA 4.5:1 for 12px text. Follows DESIGN.md
        // (button-danger pairing) as specified; the written label carries the meaning either way.
        danger: 'border-danger bg-danger-tint text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type TagProps = ComponentProps<'span'> & VariantProps<typeof tagVariants>;

/** children is the label ("verified", "beta"): a written word always carries the state, never the tone alone. */
export function Tag({ tone, className, ...props }: TagProps) {
  return <span {...props} data-tone={tone ?? 'neutral'} className={clsx(tagVariants({ tone }), className)} />;
}
