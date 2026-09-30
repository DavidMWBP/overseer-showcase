import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { OfficeState } from '@overseer/shared';
import type { Agent } from '../types';
import { FURN, H, p, W } from './world';
import { CEILING_LIGHTS, isSeated, SCREEN_GLOW_OFFSETS, seatScreens } from './furniture';
import { floorRegion, type OfficeFloorRegion } from './room';

export type LightKind =
  | 'sconce-halo'
  | 'sconce-pool'
  | 'floor-lamp-halo'
  | 'floor-lamp-pool'
  | 'ceiling-lamp'
  | 'ceiling-pool'
  | 'glass-pool'
  | 'desk-screen'
  | 'lab-screen';

export interface OfficeLight {
  graphic: Sprite;
  kind: LightKind;
  room: OfficeFloorRegion;
  /** The seat whose working occupant lights this screen. */
  spotIds?: string[];
  phase: number;
}

interface LightProfile {
  /** Daytime footprint retained at day, then shrunk as the night share rises. */
  daySize: readonly [number, number];
  nightSize: readonly [number, number];
  /** Peak alpha at the centre of the shared gradient texture; 0 by day, so every light is off in daylight. */
  dayAlpha: number;
  nightAlpha: number;
}

export const LIGHT_PROFILES: Readonly<Record<LightKind, LightProfile>> = {
  'sconce-halo': { daySize: [90, 90], nightSize: [50, 40], dayAlpha: 0, nightAlpha: 0.22 },
  'sconce-pool': { daySize: [300, 150], nightSize: [100, 54], dayAlpha: 0, nightAlpha: 0.13 },
  'floor-lamp-halo': { daySize: [90, 90], nightSize: [54, 44], dayAlpha: 0, nightAlpha: 0.22 },
  'floor-lamp-pool': { daySize: [360, 180], nightSize: [240, 122], dayAlpha: 0, nightAlpha: 0.38 },
  'ceiling-lamp': { daySize: [90, 90], nightSize: [54, 44], dayAlpha: 0, nightAlpha: 0.22 },
  'ceiling-pool': { daySize: [500, 250], nightSize: [280, 144], dayAlpha: 0, nightAlpha: 0.36 },
  'glass-pool': { daySize: [420, 210], nightSize: [140, 72], dayAlpha: 0, nightAlpha: 0.11 },
  'desk-screen': { daySize: [150, 110], nightSize: [88, 60], dayAlpha: 0, nightAlpha: 0.42 },
  'lab-screen': { daySize: [110, 90], nightSize: [70, 50], dayAlpha: 0, nightAlpha: 0.36 },
};

const ROOM_REGIONS: readonly OfficeFloorRegion[] = ['main', 'lab', 'review'];
export const RADIAL_LIGHT_TEXTURE_SIZE = 256;

function clampShare(nightShare: number): number {
  return Math.max(0, Math.min(1, nightShare));
}

function roundAlpha(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/** Cubic smoothstep gives zero slope at the centre and edge without rings or hard bands. */
export function lightFalloff(radius: number): number {
  const r = Math.max(0, Math.min(1, radius));
  return 1 - r * r * (3 - 2 * r);
}

export function radialTextureAlpha(radius: number): number {
  return Math.round(lightFalloff(radius) * 255);
}

/** Centre alpha for a light kind, linearly raised from its day value (0, off) to its night peak. */
export function lightAlpha(kind: LightKind, nightShare: number): number {
  const profile = LIGHT_PROFILES[kind];
  const n = clampShare(nightShare);
  if (n === 0) return profile.dayAlpha;
  if (n === 1) return profile.nightAlpha;
  return profile.dayAlpha + (profile.nightAlpha - profile.dayAlpha) * n;
}

/** Pixi's 4x5 colour matrix for the scene layer: one dark, slightly cool night base, so the lamps do the lighting. */
export function sceneColorMatrix(darkness: number): number[] {
  const d = clampShare(darkness);
  return [
    roundAlpha(1 - 0.68 * d), 0, 0, 0, 0,
    0, roundAlpha(1 - 0.67 * d), 0, 0, 0,
    0, 0, roundAlpha(1 - 0.62 * d), 0, roundAlpha(0.01 * d),
    0, 0, 0, 1, 0,
  ];
}

/** The warm light a lit ceiling or floor lamp throws on the floor; deeper than the bulb so the pool reads warm on the dark base. */
const LAMP_POOL_COLOR = 0xffb866;
const DESK_SCREEN_COLOR = 0x8fc4ff;
/** The QA desks' lavender test-result screens (the mean colour of `qa-desk-lit.png`). */
const QA_SCREEN_COLOR = 0xdad3f3;

/** A desk monitor, or a QA desk's screens (`lab-screen`), glows while an agent seated there is working or verifying. */
export function screenGlow(
  kind: 'desk-screen' | 'lab-screen',
  state: OfficeState | null,
  occupied: boolean,
  stalled: boolean,
  nightShare: number,
  now: number,
  frozen: boolean,
  phase = 0,
): { color: number; alpha: number } | null {
  if (!occupied || stalled || (state !== 'working' && state !== 'verifying')) return null;
  const base = lightAlpha(kind, nightShare);
  const flicker = frozen ? 1 : 0.94 + 0.06 * Math.sin(now / 90 + phase);
  return { color: kind === 'desk-screen' ? DESK_SCREEN_COLOR : QA_SCREEN_COLOR, alpha: base * flicker };
}

let radialTexture: Texture | null = null;

function sharedRadialTexture(): Texture {
  if (radialTexture) return radialTexture;

  const size = RADIAL_LIGHT_TEXTURE_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - size / 2) / (size / 2);
      const dy = (y + 0.5 - size / 2) / (size / 2);
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = radialTextureAlpha(Math.hypot(dx, dy));
    }
  }

  const source = new BufferImageSource({
    resource: pixels,
    width: size,
    height: size,
    scaleMode: 'linear',
    label: 'office-light-falloff',
  });
  radialTexture = new Texture({ source, label: 'office-light-falloff' });
  return radialTexture;
}

function fillRegionFloor(graphics: Graphics, region: OfficeFloorRegion, color: number): void {
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < H; j++) {
      if (floorRegion(i + 0.5, j + 0.5) !== region) continue;
      graphics.poly([p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)].flat()).fill({ color });
    }
  }
}

/**
 * Night multiply tints for the two glass rooms' floors: the QA corner's light grey vinyl and the meeting room's lavender
 * carpet are brought to the main carpet's tone, so the one night base reads alike across the three rooms.
 */
export const FLOOR_GRADE: Readonly<Record<'lab' | 'review', number>> = { lab: 0x9199ad, review: 0xc9f7e6 };

export interface FloorGrade {
  graphic: Graphics;
  room: 'lab' | 'review';
}

/** One multiply layer per glass room's floor tiles; it goes over the room background and under the furniture. */
export function buildFloorGrade(): FloorGrade[] {
  return (['lab', 'review'] as const).map((room) => {
    const graphic = new Graphics();
    fillRegionFloor(graphic, room, FLOOR_GRADE[room]);
    graphic.blendMode = 'multiply';
    graphic.alpha = 0;
    graphic.visible = false;
    graphic.label = `office-floor-grade-${room}`;
    return { graphic, room };
  });
}

/** Off by day; rises linearly with the night share to the full tint. */
export function updateFloorGrade(grades: readonly FloorGrade[], nightShare: number): void {
  const n = clampShare(nightShare);
  for (const { graphic } of grades) {
    graphic.alpha = n;
    graphic.visible = n > 0;
  }
}

function roomMask(region: OfficeFloorRegion): Graphics {
  const mask = new Graphics();
  const addPolygon = (points: readonly (readonly [number, number])[]) => {
    mask.poly(points.flatMap(([x, y]) => [x, y])).fill({ color: 0xffffff });
  };
  fillRegionFloor(mask, region, 0xffffff);

  // The main and lab regions include their back walls so their sconce halos stay on the wall surface.
  if (region === 'main') {
    addPolygon([p(0, 0), p(0, H), p(0, H, 4), p(0, 0, 4)]);
    addPolygon([p(0, 0), p(12, 0), p(12, 0, 4), p(0, 0, 4)]);
  } else if (region === 'lab') {
    addPolygon([p(12, 0), p(W, 0), p(W, 0, 4), p(12, 0, 4)]);
  }

  mask.label = `office-light-mask-${region}`;
  return mask;
}

function roomLightLayers(container: Container): Record<OfficeFloorRegion, Container> {
  const layers = {} as Record<OfficeFloorRegion, Container>;
  for (const region of ROOM_REGIONS) {
    const mask = roomMask(region);
    const layer = new Container();
    layer.label = `office-lights-${region}`;
    layer.mask = mask;
    container.addChild(mask, layer);
    layers[region] = layer;
  }
  return layers;
}

function radialLight(
  container: Container,
  x: number,
  y: number,
  color: number,
  kind: LightKind,
  room: OfficeFloorRegion,
  phase: number,
  spotIds?: string[],
): OfficeLight {
  const graphic = new Sprite(sharedRadialTexture());
  const profile = LIGHT_PROFILES[kind];
  graphic.anchor.set(0.5);
  graphic.position.set(x, y);
  graphic.width = profile.daySize[0];
  graphic.height = profile.daySize[1];
  graphic.tint = color;
  graphic.alpha = profile.dayAlpha;
  graphic.blendMode = 'add';
  container.addChild(graphic);
  return { graphic, kind, room, phase, ...(spotIds ? { spotIds } : {}) };
}

const MEETING_TABLE = FURN.find((furniture) => furniture.kind === 'meeting-table')!;
const overTable = (i: number, j: number) =>
  i >= MEETING_TABLE.i && i <= MEETING_TABLE.i + MEETING_TABLE.w && j >= MEETING_TABLE.j && j <= MEETING_TABLE.j + MEETING_TABLE.d;

/** Build shared-gradient lights and one static clip mask for each room. */
export function buildLights(container: Container): OfficeLight[] {
  const lights: OfficeLight[] = [];
  const layers = roomLightLayers(container);
  const add = (
    room: OfficeFloorRegion,
    x: number,
    y: number,
    color: number,
    kind: LightKind,
    phase: number,
    spotIds?: string[],
  ) => lights.push(radialLight(layers[room], x, y, color, kind, room, phase, spotIds));

  const sconces = [['l', 1.8], ['l', 11], ['r', 7.5], ['r', 14.5]] as const;
  sconces.forEach(([side, at], index) => {
    const [x, y] = side === 'r' ? p(at, 0, 3) : p(0, at, 3);
    const room = side === 'l' || at <= 12 ? 'main' : 'lab';
    add(room, x, y, 0xffd79a, 'sconce-halo', index);
    const floorI = side === 'r' ? at : 1.4;
    const floorJ = side === 'r' ? 1.4 : at;
    const [floorX, floorY] = p(floorI, floorJ);
    add(floorRegion(floorI, floorJ), floorX, floorY, 0xffc98a, 'sconce-pool', index + 4);
  });

  FURN.filter((furniture) => furniture.kind === 'lamp-floor').forEach((lamp, index) => {
    const i = lamp.i + 0.3;
    const j = lamp.j + 0.3;
    const [x, y] = p(i, j, 1.8);
    add(floorRegion(i, j), x, y, 0xffe0a8, 'floor-lamp-halo', index + 8);
    // A lamp against the right wall throws its pool onto the open floor in front of it, rather than half of it into the
    // wall, the glass and the next room.
    const byWall = i > W - 1.2;
    // The meeting room's lamp in the corner of the wall and the j = 7 glass reaches further along the glass, so its pool
    // lands on the floor the first view shows rather than past the wall and under the view's bottom edge.
    const byGlass = byWall && j < 9;
    const poolI = byGlass ? i - 1.2 : byWall ? i - 0.4 : i;
    const poolJ = byGlass ? j + 0.5 : byWall ? j + 0.6 : j;
    const [floorX, floorY] = p(poolI, poolJ);
    add(floorRegion(poolI, poolJ), floorX, floorY, LAMP_POOL_COLOR, 'floor-lamp-pool', index + 10);
  });

  // Local colour pools in the glass rooms: in front of each QA desk's screens, and by the meeting table.
  [[13.8, 3.8, 0x9fe6ff], [17.2, 3.8, 0x9fe6ff], [16.8, 11, 0xffd9a0]].forEach(([i, j, color], index) => {
    const [x, y] = p(i!, j!);
    add(floorRegion(i!, j!), x, y, color!, 'glass-pool', index + 12);
  });

  CEILING_LIGHTS.forEach((fixture, index) => {
    const room = floorRegion(fixture.i, fixture.j);
    const [lampX, lampY] = p(fixture.i, fixture.j, 2.9);
    add(room, lampX, lampY, fixture.color, 'ceiling-lamp', index + 16);
    // The pendant over the meeting table throws its pool past the table's glass-side edge, onto the open floor, where the
    // table top would otherwise catch most of it.
    const poolI = overTable(fixture.i, fixture.j) ? MEETING_TABLE.i - 0.7 : fixture.i;
    const [floorX, floorY] = p(poolI, fixture.j);
    add(room, floorX, floorY, LAMP_POOL_COLOR, 'ceiling-pool', index + 20);
  });

  // Each desk seat's glow sits on the lit pixels of the screen it looks at: a monitor back, a monitor front, the
  // orchestrator's pair or a QA desk's two screens.
  seatScreens().forEach(({ spot, asset, at }, index) => {
    const offset = SCREEN_GLOW_OFFSETS[asset];
    const kind = asset === 'qa-desk' ? 'lab-screen' : 'desk-screen';
    add(floorRegion(spot.x, spot.y), at[0] + offset[0], at[1] + offset[1], kind === 'lab-screen' ? QA_SCREEN_COLOR : DESK_SCREEN_COLOR, kind, index, [spot.id]);
  });

  return lights;
}

/** Update light size and intensity, then screens lit by seated working or verifying agents. */
export function updateLights(lights: readonly OfficeLight[], agents: readonly Agent[], nightShare: number, now: number, frozen: boolean): void {
  const n = clampShare(nightShare);
  const occupants = new Map(agents.filter(isSeated).map((agent) => [agent.assignedSpotId, agent]));
  for (const light of lights) {
    const profile = LIGHT_PROFILES[light.kind];
    light.graphic.width = profile.daySize[0] + (profile.nightSize[0] - profile.daySize[0]) * n;
    light.graphic.height = profile.daySize[1] + (profile.nightSize[1] - profile.daySize[1]) * n;
    if (light.kind !== 'desk-screen' && light.kind !== 'lab-screen') {
      light.graphic.alpha = lightAlpha(light.kind, n);
      continue;
    }

    // A screen's glow is lit while its seat has a seated, working or verifying occupant.
    const seated = (light.spotIds ?? []).map((spotId) => occupants.get(spotId)).filter((agent) => agent !== undefined);
    const agent = seated.find((candidate) => !candidate.stalled && (candidate.state === 'working' || candidate.state === 'verifying'));
    const glow = screenGlow(light.kind, agent?.state ?? null, agent !== undefined, agent?.stalled ?? false, n, now, frozen, light.phase);
    light.graphic.alpha = glow?.alpha ?? 0;
  }
}
