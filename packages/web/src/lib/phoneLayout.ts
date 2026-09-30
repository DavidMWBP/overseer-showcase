import { useEffect, useState } from 'react';

/**
 * The phone layout: a viewport 767 px wide or less, or a touch screen (coarse primary pointer) 500 px tall or less, such as
 * a phone held in landscape. Every CSS phone block uses this exact condition.
 */
export const PHONE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)';

/**
 * The exact complement of `PHONE_QUERY`, which every CSS desktop block uses: 768 px wide or more and either a primary
 * pointer that is not coarse or a height of 501 px or more. It is spelled as a comma list, not `not (...)`, so Safari 16
 * reads it.
 */
export const DESKTOP_QUERY = '(min-width: 768px) and (pointer: fine), (min-width: 768px) and (pointer: none), (min-width: 768px) and (min-height: 501px)';

/** Does the phone layout apply now? For a one-off read; a component that renders by it uses `usePhoneLayout`. */
export function isPhoneLayout(): boolean {
  return typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;
}

/** True while the phone layout applies; a resize or rotation across the condition re-renders without a reload. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(isPhoneLayout);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia(PHONE_QUERY);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return phone;
}
