import type { TreeTrack } from '@api-types/journey';
import { clsx } from 'clsx';
import { Check, ChevronDown, Circle } from 'lucide-react';
import { type ComponentType, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { formatNumber, toLocale } from '../../lib/i18n';

type NodeState = TreeTrack['nodes'][number]['state'];

export type SkillTreeProps = {
  /** `Journey.tree` from GET /api/player/journey. Presentational: the parent fetches, this component never does. */
  tree: readonly TreeTrack[];
  /**
   * Display names by track slug. The contract's TreeTrack carries only the track SLUG (node names are already localised,
   * track names are not), so the caller may pass names it has. A track without one reads as its humanised slug.
   */
  trackNames?: Readonly<Record<string, string>>;
  className?: string;
};

/*
 * Readings chosen where the criteria are open:
 *   - Track level bar: the contract exposes no per-track level, so the bar is the track's mastered nodes out of its
 *     nodes (with the number written beside it). It is not a comparison with anyone else.
 *   - "locked / next" is one state (the contract's `locked`) with one marker and one label, "Locked".
 *   - "Collapsible per track on mobile": every track has a disclosure toggle at every width (a real <button> with
 *     aria-expanded), expanded to begin with so no state is hidden until asked for. The level bar stays visible collapsed.
 *   - Heading level: the track name is an <h3>; the screen that mounts the tree owns the <h2> above it.
 */

/** The filled circle, "●". lucide has no filled circle whose markup differs from its outline one. */
const Dot: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <circle cx="12" cy="12" r="7" />
  </svg>
);

// One marker shape per state (✓ ● ○): colour is never the only signal (DESIGN.md Second Signal Rule).
const PRESENTATION = {
  mastered: { icon: Check, marker: 'text-accent', row: 'border-line bg-paper', name: 'text-ink' },
  training: { icon: Dot, marker: 'text-ink', row: 'border-ink bg-paper', name: 'text-ink' },
  locked: { icon: Circle, marker: 'text-muted', row: 'border-line bg-bg', name: 'text-muted' },
} as const satisfies Record<NodeState, { icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>; marker: string; row: string; name: string }>;

/** Runtime data can be older than the contract: an unknown state gets the calmest presentation, never a claim. */
function resolve(state: unknown): NodeState {
  return typeof state === 'string' && Object.hasOwn(PRESENTATION, state) ? (state as NodeState) : 'locked';
}

/** `ball-mastery` -> `Ball mastery`. */
function humanise(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

function TrackSection({ track, name }: { track: TreeTrack; name: string }) {
  const { t, i18n } = useTranslation('skill-tree');
  const id = useId();
  const [open, setOpen] = useState(true);
  const locale = toLocale(i18n.language);

  const total = track.nodes.length;
  const done = track.nodes.filter((node) => resolve(node.state) === 'mastered').length;
  const progress = t('progress', { done: formatNumber(done, locale), total: formatNumber(total, locale) });

  return (
    <Card className="flex min-w-0 flex-col gap-3">
      <h3 className="m-0 text-xl leading-tight font-bold tracking-tight text-ink">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-nodes`}
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-control border-0 bg-transparent p-0 text-left text-inherit"
        >
          <span className="min-w-0 wrap-anywhere">{name}</span>
          <ChevronDown
            aria-hidden="true"
            className={clsx('size-6 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-180')}
          />
        </button>
      </h3>

      {total > 0 ? (
        <div className="flex flex-col gap-2">
          <div
            role="progressbar"
            aria-label={`${t('levelLabel')}: ${name}`}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={progress}
            className="h-2.5 overflow-hidden rounded-pill bg-line"
          >
            <div className="h-full rounded-pill bg-accent" style={{ width: `${(done / total) * 100}%` }} />
          </div>
          <p className="m-0 text-sm text-muted">{progress}</p>
        </div>
      ) : null}

      <ol id={`${id}-nodes`} hidden={!open} className="m-0 flex list-none flex-col gap-2 p-0">
        {total === 0 ? <li className="text-base text-muted">{t('emptyTrack')}</li> : null}
        {track.nodes.map((node) => {
          const state = resolve(node.state);
          const { icon: Marker, marker, row, name: nameTone } = PRESENTATION[state];
          return (
            <li
              key={node.slug}
              data-state={state}
              className={clsx('flex min-h-11 min-w-0 items-start gap-3 rounded-control border p-3', row)}
            >
              <Marker aria-hidden="true" className={clsx('mt-0.5 size-6 shrink-0', marker)} />
              <div className="flex min-w-0 flex-col">
                <span className={clsx('text-base leading-snug font-bold wrap-anywhere', nameTone)}>{node.name}</span>
                <span className="text-base leading-snug text-muted">{t(`states.${state}`)}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export function SkillTree({ tree, trackNames, className }: SkillTreeProps) {
  const { t } = useTranslation('skill-tree');

  if (tree.length === 0) {
    return <EmptyState className={className} title={t('emptyTitle')} hint={t('emptyHint')} />;
  }

  const nameOf = (slug: string): string => {
    const given = trackNames !== undefined && Object.hasOwn(trackNames, slug) ? trackNames[slug]?.trim() : undefined;
    return given !== undefined && given !== '' ? given : humanise(slug);
  };

  return (
    <ul aria-label={t('treeLabel')} className={clsx('m-0 flex min-w-0 list-none flex-col gap-4 p-0', className)}>
      {tree.map((track) => (
        <li key={track.track} className="min-w-0">
          <TrackSection track={track} name={nameOf(track.track)} />
        </li>
      ))}
    </ul>
  );
}
