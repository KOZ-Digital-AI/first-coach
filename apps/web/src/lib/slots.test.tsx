import { describe, expect, test } from 'bun:test';
import type { ComponentType } from 'react';
import { forwardRef, memo } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectSlot, SLOT_NAMES, type SlotProps, type SlotRegistry, useSlot } from './slots';

const Alpha = () => <p>alpha</p>;
const Zeta = () => <p>zeta</p>;

function renderAll(components: readonly ComponentType<Record<string, never>>[]): string {
  return renderToStaticMarkup(
    <>
      {components.map((Component, index) => (
        <Component key={index} />
      ))}
    </>,
  );
}

describe('collectSlot', () => {
  test('renders modules in ascending path order regardless of insertion order', () => {
    const registry: SlotRegistry = {
      today: {
        '../features/zeta/today-extra.tsx': { default: Zeta },
        '../features/alpha/today-extra.tsx': { default: Alpha },
      },
    };
    expect(renderAll(collectSlot(registry, 'today'))).toBe('<p>alpha</p><p>zeta</p>');
  });

  test('an empty registry yields no components and renders nothing', () => {
    const components = collectSlot({}, 'today');
    expect(components).toEqual([]);
    expect(renderAll(components)).toBe('');
  });

  test('a slot with an empty module map yields no components', () => {
    expect(collectSlot({ today: {} }, 'today')).toEqual([]);
  });

  test('a module registered under another slot is not returned', () => {
    const registry: SlotRegistry = {
      header: { '../features/alpha/header-extra.tsx': { default: Alpha } },
      today: { '../features/zeta/today-extra.tsx': { default: Zeta } },
    };
    expect(renderAll(collectSlot(registry, 'today'))).toBe('<p>zeta</p>');
    expect(renderAll(collectSlot(registry, 'header'))).toBe('<p>alpha</p>');
  });

  test('a module with only named exports is ignored', () => {
    const registry: SlotRegistry = {
      today: {
        '../features/a/today-extra.tsx': { Named: Alpha },
        '../features/b/today-extra.tsx': { default: Zeta, Other: Alpha },
      },
    };
    expect(renderAll(collectSlot(registry, 'today'))).toBe('<p>zeta</p>');
  });

  test('a default export that is not a component is ignored without crashing', () => {
    const registry: SlotRegistry = {
      today: {
        '../features/a/today-extra.tsx': { default: 'not a component' },
        '../features/b/today-extra.tsx': { default: 42 },
        '../features/c/today-extra.tsx': { default: null },
        '../features/d/today-extra.tsx': { default: { plain: 'object' } },
        '../features/e/today-extra.tsx': { default: Alpha },
      },
    };
    expect(renderAll(collectSlot(registry, 'today'))).toBe('<p>alpha</p>');
  });

  test('memo and forwardRef components count as components', () => {
    const Memoised = memo(() => <p>memo</p>);
    const Forwarded = forwardRef<HTMLParagraphElement>((_props, ref) => <p ref={ref}>fwd</p>);
    const registry: SlotRegistry = {
      today: {
        '../features/a/today-extra.tsx': { default: Memoised },
        '../features/b/today-extra.tsx': { default: Forwarded },
      },
    };
    expect(renderAll(collectSlot(registry, 'today'))).toBe('<p>memo</p><p>fwd</p>');
  });

  test('ordering is plain code-unit comparison, not locale aware', () => {
    const Upper = () => <p>upper</p>;
    const Lower = () => <p>lower</p>;
    const registry: SlotRegistry = {
      today: {
        '../features/a/today-extra.tsx': { default: Lower },
        '../features/B/today-extra.tsx': { default: Upper },
      },
    };
    expect(renderAll(collectSlot(registry, 'today'))).toBe('<p>upper</p><p>lower</p>');
  });
});

describe('useSlot', () => {
  test('returns an array under bun and the same reference on every call', () => {
    const first = useSlot('header');
    expect(Array.isArray(first)).toBe(true);
    expect(useSlot('header')).toBe(first);
  });

  test('every declared slot name resolves to an array', () => {
    expect(SLOT_NAMES).toEqual(['root', 'header', 'today', 'drill', 'drill-detail', 'privacy-panel']);
    for (const name of SLOT_NAMES) {
      expect(Array.isArray(useSlot(name))).toBe(true);
    }
  });

  test('its return type carries SlotProps for the slot name', () => {
    const components: readonly ComponentType<SlotProps['today']>[] = useSlot('today');
    const drillDetail: readonly ComponentType<SlotProps['drill-detail']>[] = useSlot('drill-detail');
    expect(components).toBeDefined();
    expect(drillDetail).toBeDefined();
  });
});
