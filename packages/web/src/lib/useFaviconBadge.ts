import { useEffect, useRef } from 'react';

const ICON_SIZE = 64;
const FALLBACK_WARN = '#c96a5c';
let icon: Promise<HTMLImageElement | null> | null = null;

function loadIcon() {
  icon ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = '/icon.svg';
  });
  return icon;
}

/** Mirrors the needs-you item count in the tab title and, where supported, on the favicon. */
export function useFaviconBadge(count: number) {
  const originalHref = useRef<string | null>(null);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && originalHref.current === null) originalHref.current = link.getAttribute('href') ?? link.href;
    document.title = count > 0 ? `(${count}) Overseer` : 'Overseer';

    if (count <= 0) {
      if (link && originalHref.current !== null) link.href = originalHref.current;
      return;
    }

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!link || !context) return;
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    let cancelled = false;

    void loadIcon().then((image) => {
      if (cancelled || !image) return;
      context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || FALLBACK_WARN;
      context.beginPath();
      context.arc(49, 49, 13, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#fff';
      context.font = 'bold 18px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(count > 9 ? '9+' : String(count), 49, 50);
      link.href = canvas.toDataURL('image/png');
    });

    return () => { cancelled = true; };
  }, [count]);
}
