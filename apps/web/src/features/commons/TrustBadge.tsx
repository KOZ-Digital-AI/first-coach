import type { TrustStatus } from '@api-types/primitives';
import { BadgeCheck, ClipboardCheck, GraduationCap, type LucideIcon, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tag } from '../../components/ui/tag';
// Side-effect import: registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';

/** The `attribution.source` the seeded Genesis drills carry (config/commons/football/drills/*.json). */
export const GENESIS_DRAFT_SOURCE = 'FIRST COACH Community Draft';

type MessageKey = 'community' | 'reviewed' | 'expertVerified' | 'academyVerified';

type Presentation = {
  key: MessageKey;
  icon: LucideIcon;
  /** Only verified statuses may name the organisation that verified them ("Verified by <org>"). */
  verified: boolean;
  tone: 'neutral' | 'accent';
};

// Keyed by the contract's TrustStatus, so a new status is a compile error here. One shape per status: colour is never the
// only signal (DESIGN.md Second Signal Rule). Tones stay neutral/accent (Ink text on both): trust is not an alert.
const PRESENTATION = {
  COMMUNITY: { key: 'community', icon: Users, verified: false, tone: 'neutral' },
  REVIEWED: { key: 'reviewed', icon: ClipboardCheck, verified: false, tone: 'neutral' },
  EXPERT_VERIFIED: { key: 'expertVerified', icon: BadgeCheck, verified: true, tone: 'accent' },
  ACADEMY_VERIFIED: { key: 'academyVerified', icon: GraduationCap, verified: true, tone: 'accent' },
} as const satisfies Record<TrustStatus, Presentation>;

/** Runtime data can be older than the contract: anything unrecognised gets the lowest-trust presentation, never a claim. */
function resolve(status: unknown): TrustStatus {
  return typeof status === 'string' && Object.hasOwn(PRESENTATION, status) ? (status as TrustStatus) : 'COMMUNITY';
}

export type TrustBadgeProps = {
  status: TrustStatus;
  /** The drill's `attribution.source`. The exact Genesis draft source turns COMMUNITY into "Community Draft". */
  source?: string;
  /** The verifying organisation (`DrillReview.orgLabel`). Read only for EXPERT_VERIFIED and ACADEMY_VERIFIED. */
  orgLabel?: string;
  className?: string;
};

/**
 * Compact inline trust badge: a decorative icon plus a written label. The label is the accessible name (no title-only
 * information) and long organisation names truncate with CSS while the full text stays in the DOM. Not interactive.
 */
export function TrustBadge({ status, source, orgLabel, className }: TrustBadgeProps) {
  const { t } = useTranslation('trust-badge');
  const resolved = resolve(status);
  const { key, icon: Icon, verified, tone } = PRESENTATION[resolved];
  const org = typeof orgLabel === 'string' ? orgLabel.trim() : '';
  const label =
    verified && org !== ''
      ? t('verifiedBy', { org })
      : resolved === 'COMMUNITY' && source === GENESIS_DRAFT_SOURCE
        ? t('communityDraft')
        : t(key);
  return (
    <Tag tone={tone} data-status={resolved} className={className}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </Tag>
  );
}
