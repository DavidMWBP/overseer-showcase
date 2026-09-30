import { useEffect, useState, type CSSProperties } from 'react';

export type MascotState = 'idle' | 'thinking' | 'working' | 'asking' | 'sleeping' | 'offline' | 'error';
export type MascotEnergy = 'high' | 'normal' | 'low';

export interface MascotProps {
  state: MascotState;
  energy?: MascotEnergy;
  size?: number;
  label?: string;
}

type SpriteFrame = { key: string; x: number; y: number; w: number; h: number };
type SpriteSheet = {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
  meta: { size: { w: number; h: number } };
};

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
let spriteSheetRequest: Promise<SpriteSheet> | undefined;

function isValidSpriteSheet(data: unknown): data is SpriteSheet {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.frames !== 'object' || !obj.frames) return false;
  const meta = obj.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') return false;
  const size = meta.size as Record<string, unknown> | undefined;
  if (!size || typeof size !== 'object') return false;
  if (typeof size.w !== 'number' || typeof size.h !== 'number') return false;
  return true;
}

function loadSpriteSheet(): Promise<SpriteSheet> {
  if (!spriteSheetRequest) {
    spriteSheetRequest = fetch('/mascot/me-1.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Mascot sheet metadata failed with ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (!isValidSpriteSheet(data)) throw new Error('Mascot sheet metadata is malformed');
        return data;
      })
      .catch((error: unknown) => {
        spriteSheetRequest = undefined;
        throw error;
      });
  }
  return spriteSheetRequest;
}

function framesFor(spriteSheet: SpriteSheet | null, prefix: string): SpriteFrame[] {
  if (!spriteSheet) return [];
  return Object.entries(spriteSheet.frames)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ key, ...value.frame }))
    .sort((a, b) => Number(a.key.slice(prefix.length)) - Number(b.key.slice(prefix.length)));
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(reducedMotionQuery).matches === true);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(reducedMotionQuery);
    const update = () => setReducedMotion(media.matches);
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return reducedMotion;
}

export function Mascot({ state, energy = 'normal', size = 96, label = `${state} mascot` }: MascotProps) {
  const [sheetFailed, setSheetFailed] = useState(false);
  const [spriteSheet, setSpriteSheet] = useState<SpriteSheet | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    let mounted = true;
    void loadSpriteSheet().then((sheet) => {
      if (mounted) setSpriteSheet(sheet);
    }).catch(() => {
      if (mounted) setSheetFailed(true);
    });
    return () => { mounted = false; };
  }, []);

  const poseState = state === 'offline' ? 'idle' : state;
  const bust = size < 48;
  const baseSize = bust ? 32 : 64;
  const scale = Math.max(1, Math.round(size / baseSize));
  const variant = energy === 'low'
    ? (bust ? 'bust-low' : 'low')
    : energy === 'high' && poseState === 'idle'
      ? (bust ? 'bust-high' : 'high')
      : (bust ? 'bust' : 'default');
  const preferredFrames = framesFor(spriteSheet, `${poseState}/${variant}/`);
  const frames = preferredFrames.length ? preferredFrames : framesFor(spriteSheet, `${poseState}/${bust ? 'bust' : 'default'}/`);
  const firstFrame = frames[0];
  const frameFolder = firstFrame?.key.split('/')[1] ?? (bust ? 'bust' : 'default');
  const frameCount = frames.length;
  const frameStep = frameCount > 1 && firstFrame ? frames[1]!.x - firstFrame.x : firstFrame?.w ?? 0;
  const renderSize = baseSize * scale;
  const spriteStyle: (CSSProperties & Record<`--${string}`, string | number>) | undefined = spriteSheet && firstFrame ? {
    width: spriteSheet.meta.size.w * scale,
    height: spriteSheet.meta.size.h * scale,
    top: -firstFrame.y * scale,
    imageRendering: 'pixelated',
    '--frame-start': `${-firstFrame.x * scale}px`,
    '--frame-end': `${-(firstFrame.x + frameStep * frameCount) * scale}px`,
    '--frame-count': frameCount,
    '--frame-duration': energy === 'low' ? '4s' : '2s',
  } : undefined;

  const useSvg = sheetFailed || !spriteSheet || !firstFrame;
  return (
    <span
      className={`mascot mascot-${state} mascot-energy-${energy}${reducedMotion ? ' mascot-reduced-motion' : ''}`}
      role="img"
      aria-label={label}
      data-reduced-motion={String(reducedMotion)}
      style={{ width: useSvg ? size : renderSize, height: useSvg ? size : renderSize, ...(state === 'offline' ? { filter: 'grayscale(1)' } : {}) }}
    >
      <span className="visually-hidden">{label}</span>
      {useSvg ? (
        <MascotSvg state={state} energy={energy} size={size} />
      ) : (
        <span
          className="mascot-atlas-frame"
          data-pose-key={`${poseState}/${frameFolder}/0`}
          data-crop={bust ? 'bust' : 'full-body'}
          data-frame-index="0"
          style={{ width: firstFrame.w * scale, height: firstFrame.h * scale }}
        >
          <img
            className="mascot-atlas-image"
            src="/mascot/me-1.png"
            alt=""
            aria-hidden="true"
            draggable={false}
            onError={() => setSheetFailed(true)}
            style={{ ...spriteStyle!, ...(reducedMotion ? { left: spriteStyle!['--frame-start'] as string, animation: 'none' } : {}) }}
            data-testid="mascot-atlas-image"
          />
        </span>
      )}
    </span>
  );
}

function MascotSvg({ state, energy, size = 96 }: Pick<MascotProps, 'state' | 'energy' | 'size'>) {
  const stroke = { stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const eyes = state === 'sleeping'
    ? <><path d="m45 39 8 1" /><path d="m67 40 8-1" /></>
    : energy === 'low'
      ? <><path d="M42 38q5-4 10 0" /><path className="mascot-eye" d="M47 40v2" /><path d="M68 38q5-4 10 0" /><path className="mascot-eye mascot-eye-delay" d="M73 40v2" /></>
      : <><path className="mascot-eye" d="M47 37v4" /><path className="mascot-eye mascot-eye-delay" d="M73 37v4" /></>;

  return (
    <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true" focusable="false">
      <g className="mascot-pose">
        <g className="mascot-legs" fill="none" {...stroke}>
          <path d="M48 91 43 108 34 110" />
          <path d="M72 91 77 108 86 110" />
        </g>

        {state === 'thinking' && <g className="mascot-arm mascot-arm-think" fill="none" {...stroke}><path d="M42 65 29 76 37 83" /><path d="M78 65 85 75 75 82 66 70" /></g>}
        {state === 'working' && <g className="mascot-arm mascot-arm-work" fill="none" {...stroke}><path d="M43 67 27 80 39 89" /><path d="M77 67 91 78 80 88" /></g>}
        {state === 'asking' && <><g className="mascot-arm" fill="none" {...stroke}><path d="M42 67 29 77 34 90" /></g><g className="mascot-arm mascot-arm-wave" fill="none" {...stroke}><path d="M78 67 91 48 91 29" /><path d="m91 34-8-7m8 7 7-8" /></g></>}
        {(state === 'idle' || state === 'offline' || state === 'error' || state === 'sleeping') && <g className="mascot-arm mascot-arm-idle" fill="none" {...stroke}><path d="M43 67 28 78 37 89" /><path d="M77 67 92 78 83 89" /></g>}

        <path className="mascot-body" d="M40 62Q60 52 80 62L77 94Q60 102 43 94Z" fill="var(--mascot-suit)" {...stroke} />
        <path d="m47 62 13 13 13-13M60 75v22" fill="none" {...stroke} />
        <circle cx="60" cy="38" r="27" fill="var(--mascot-skin)" {...stroke} />
        <path className="mascot-quiff" d="M37 25Q46 5 59 16Q72 2 84 25Q72 18 60 24Q48 17 37 25Z" fill="var(--mascot-hair)" {...stroke} />

        <g className="mascot-face" fill="none" {...stroke}>
          {eyes}
          {state === 'offline' ? <path d="m48 54 8-3 8 3 8-3" /> : state === 'error' ? <path d="M48 55q12-9 24 0" /> : state === 'sleeping' ? <path d="M53 54q7 4 14 0" /> : <path className="mascot-grin" d="M46 51q14 16 28 0-14 7-28 0Z" fill="#f6f1df" />}
        </g>

        {energy === 'low' && state !== 'sleeping' && <path className="mascot-sweat" d="M91 36q6 8 0 12-7-4 0-12Z" fill="var(--accent)" stroke="currentColor" strokeWidth="2" />}
      </g>

      {state === 'thinking' && <g className="mascot-thought" fill="#fff" {...stroke}>
        <path className="mascot-thought-cloud" d="M97.2 6.9A7.5 7.5 0 0 1 111.5 9.7A6.5 6.5 0 1 1 105.7 20.9A5.5 5.5 0 0 1 95.7 19.5A6.5 6.5 0 1 1 97.2 6.9Z" />
        <circle className="mascot-thought-trail" cx="102" cy="32" r="3.2" strokeWidth="2" />
        {size > 32 && <>
          <circle className="mascot-thought-trail" cx="93" cy="29" r="2.5" strokeWidth="2" />
          <g className="mascot-thought-dots" fill="currentColor" stroke="none">
            <circle className="mascot-thought-dot" cx="97.5" cy="13" r="1.2" />
            <circle className="mascot-thought-dot mascot-thought-dot-delay-1" cx="102" cy="13" r="1.2" />
            <circle className="mascot-thought-dot mascot-thought-dot-delay-2" cx="106.5" cy="13" r="1.2" />
          </g>
        </>}
      </g>}
      {state === 'working' && <g className="mascot-work-lines" fill="none" {...stroke}><path d="M17 82h86v10H17z" fill="var(--surface-2)" /><path d="m27 75-6-7m72 7 6-7" /></g>}
      {state === 'asking' && <text className="mascot-question" x="102" y="36" textAnchor="middle" fill="var(--running)" stroke="currentColor" strokeWidth="1" paintOrder="stroke" fontSize="28" fontWeight="700">?</text>}
      {state === 'sleeping' && <g className="mascot-zz" fill="var(--accent)" fontWeight="700"><text x="85" y="44" fontSize="15">z</text><text x="96" y="29" fontSize="20">Z</text><text x="107" y="12" fontSize="24">Z</text></g>}
      {state === 'offline' && <g className="mascot-plug" fill="none" {...stroke}><path d="M91 76h9v11h-9m9-7h8m-5-5v10" /><path d="M86 88c4 0 5-2 5-6" /></g>}
      {state === 'error' && <g className="mascot-spark" fill="var(--warn)" {...stroke}><path d="m91 19 7 7 9-4-4 10 7 6-11 1-2 10-6-8-10 4 4-10-7-7 11-1Z" /></g>}
    </svg>
  );
}
