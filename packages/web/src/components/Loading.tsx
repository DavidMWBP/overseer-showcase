import { useEffect, useState, type ReactNode } from 'react';
import { Shimmer } from '@shimmer-from-structure/react';

const REDUCED = '(prefers-reduced-motion: reduce)';

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(REDUCED).matches;
}

/**
 * The one shimmer entry point: views import this, never the library.
 *
 * Contract: while `loading`, pass a `placeholder` that renders the shape of the arrived content — the same rows,
 * labels and boxes, with placeholder values. The library measures the *rendered* DOM and skips every element whose
 * box is zero wide or high, so real content that is still empty (an empty `<ul>`, a body guarded by `data === null`)
 * measures nothing, paints no shimmer and reserves no height: the blank and the jump this component exists to remove.
 * Pass the real content as `children` (rendered once `loading` is false) and the filled-in shape as `placeholder`.
 * The library paints only leaves (img, svg, video, canvas, iframe, input, textarea, button) and walks every other
 * element into its element children, so a `<select>` is walked into its zero-sized `<option>`s and an element's own
 * text node (a `<label>`'s "Model", a `<p>` that also holds a `<code>`) is never painted. Put
 * `data-shimmer-no-children` on such a placeholder element to paint it as one box, or wrap the bare text in a `<span>`.
 *
 * `templateProps` is the library's alternative when the placeholder is the same component as the content: it is
 * spread onto the first child during loading, so supply non-empty placeholder values rather than relying on an empty
 * fallback. The measuring copy is hidden in styles.css (`.shimmer-measure-container`), since the library only makes
 * text transparent and would let borders, backgrounds and badges show through. The blocks use the theme tokens
 * `--line` (base) and `--muted` (wave), and `.shimmer-still` stops the animation under prefers-reduced-motion.
 *
 * Wrap the smallest block that waits on data (a list, a card body), not a flex/grid sizing chain, keep sizing classes
 * on a node above this component, and give the wrapped structure a definite height of its own.
 *
 * A grid or flex parent's gap disappears, because this wrapper is one item where the arrived content is several:
 * give the placeholder the parent's own display and gap (the accounts rows, the review list).
 *
 * Two rules the placeholder's own prose brings with it: mark it `aria-hidden` when it sits inside a live region
 * (`aria-busy` does not take a subtree out of the accessibility tree, and the `role="status"` label below already
 * carries the state), and pass `loading` as false once the fetch has failed — an unloaded-and-errored view is not
 * loading, and shimmering invented content for the whole outage is worse than the blank.
 */
export function Loading({ loading, placeholder, children, templateProps, label = 'Loading…' }: {
  loading: boolean;
  /** Announced to assistive technology while loading, since the shimmer itself is silent. */
  label?: string;
  /** The measured structure while loading; required in practice whenever `children` can render empty. */
  placeholder?: ReactNode;
  children: ReactNode;
  templateProps?: Record<string, unknown>;
}) {
  const [still, setStill] = useState(reducedMotion);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia(REDUCED);
    const onChange = () => setStill(media.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);
  if (!loading) return <>{children}</>;
  return (
    <div className={still ? 'shimmer shimmer-still' : 'shimmer'} data-testid="shimmer" aria-busy="true">
      <span role="status" className="visually-hidden">{label}</span>
      <Shimmer loading backgroundColor="var(--line)" shimmerColor="var(--muted)" templateProps={templateProps}>
        {placeholder ?? children}
      </Shimmer>
    </div>
  );
}
