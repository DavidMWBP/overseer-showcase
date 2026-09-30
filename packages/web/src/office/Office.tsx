import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { BoardResponse, OfficeSession, WsMessage } from '@overseer/shared';
import { deriveScene, type SceneFrame } from './officeModel';
import { SceneSim, type SceneClock } from './sceneSim';
import type { StageSize } from './labelLayout';
import { OfficeCountRow, roomPropsInput, type OfficeRoomProps } from './RoomProps';
import { TaskPane } from '../views/TaskPane';
import { OfficeStage } from './pixi/OfficeStage';
import { WORLD_HEIGHT, WORLD_WIDTH } from './pixi/world';
import type { OfficeSceneEffects, TimedOfficeEffect } from './pixi/effects';
import type { Agent } from './types';
import { repoOrder as boardRepoOrder } from './badges';
import { captureMode } from './config';
import { AgentCard, BadgeKey } from './PhoneBadges';
import { usePhoneLayout } from '../lib/phoneLayout';
import './office.css';

const STAGE_HEIGHT_RESERVE = 128;
/** Chat docks only beside a room at least this wide (CSS px), on top of the 380 px it needs beside the stage. */
export const CHAT_DOCK_MIN_STAGE = 640;
/** The room's world size (1680x1056) is its stage aspect. */
const STAGE_ASPECT = WORLD_WIDTH / WORLD_HEIGHT;
const LIGHTING_REFRESH_MS = 60_000;
const OFFICE_EFFECT_MS = 3_000;
const OFFICE_MERGED_EFFECT_MS = 2_000;

type OfficeMilestoneMessage = Extract<WsMessage, { type: 'office_milestone' }>;
type OfficeEffectTarget = 'printer' | 'review' | 'merged';
interface ActiveOfficeEffect extends TimedOfficeEffect {}
type OfficeEffects = Record<OfficeEffectTarget, ActiveOfficeEffect | null>;

function effectTarget(kind: OfficeMilestoneMessage['kind']): OfficeEffectTarget {
  if (kind === 'verify_passed' || kind === 'verify_failed') return 'printer';
  if (kind === 'review_ready') return 'review';
  return 'merged';
}

function effectDuration(kind: OfficeMilestoneMessage['kind'], reduced: boolean): number {
  return reduced || kind !== 'merged' ? OFFICE_EFFECT_MS : OFFICE_MERGED_EFFECT_MS;
}

/** Preserve the online viewport cap while deriving it from the Office box that remains below an outage banner. */
export function officeStageMaxWidth(officeHeight: number, aspect = STAGE_ASPECT): number {
  return Math.max(0, officeHeight - STAGE_HEIGHT_RESERVE) * aspect;
}

/**
 * The browser's saved Office renderer choice from when a Classic room existed. Nothing reads it any more; the Office
 * removes it once on load, so a stored `classic` or `pixi` changes nothing.
 */
export const LEGACY_OFFICE_RENDERER_KEY = 'overseer.officeRenderer';

/** The one-line note under an office with nobody in it. */
export const OFFICE_EMPTY_NOTE = 'No sessions are running, so the office is empty.';

/** The one-line note under the last-known room while the daemon's feed is down or its set has not arrived since a reconnect; the room is dimmed and frozen at the same time. */
export const OFFICE_UNAVAILABLE_NOTE = 'Activity unavailable, reconnecting';

/** True when the user asked for reduced motion: characters stand still and the animation loop never starts. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/** True while the tab is hidden: the animation loop stops and resumes when the tab is shown again. */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

/** The stage's pixel size, which the Chat dock rule compares with the Office content width. */
export function useStageSize(ref: { current: HTMLElement | null }): StageSize {
  const [size, setSize] = useState<StageSize>({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      // While another view shows, the shell hides the room with display:none and every box measures 0. Keeping the last
      // real size means the labels come back where they were on return instead of being laid out for a zero stage.
      if (rect.width === 0 && rect.height === 0) return;
      setSize((prev) => (prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** The Office content box after the shell's rail and main padding. */
function useOfficeContentSize(ref: { current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      // Office is display:none while another view shows. Keep the last real size until it becomes visible again.
      if (rect.width === 0 && rect.height === 0) return;
      setSize((prev) => (prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export interface OfficeProps {
  /** The sessions the feed has shown, or null until the first snapshot arrives: an unloaded office is not an empty one. */
  sessions: OfficeSession[] | null;
  /** One live socket milestone. It is consumed immediately and is never reconstructed from a session snapshot. */
  milestone?: OfficeMilestoneMessage | null;
  onMilestoneConsumed?: (milestone: OfficeMilestoneMessage) => void;
  /** The board the characters' cards come from: a click opens the same task pane the Board renders, over the room. */
  board?: BoardResponse | null;
  /** The shell's board version, so an open pane refetches when the board changes. */
  version?: number;
  eventTicks?: Record<string, number>;
  /** Injectable local wall clock for the room lighting; defaults to SceneSim's local clock. */
  sceneClock?: SceneClock;
  offline?: boolean;
  /**
   * The held set predates this connection: after a reconnect the shell keeps the last-known set until the daemon's
   * snapshot arrives, so it is drawn dimmed and frozen with the reconnecting note rather than called empty. Distinct from
   * `offline` because the daemon is reachable again and an open pane's own fetches are not affected.
   */
  stale?: boolean;
  /** False while another view shows: the room stays mounted (its desks and characters survive) but is hidden and its loop pauses. */
  active?: boolean;
  /** Close the shell-owned panel before opening an Office task pane or focusing docked Chat. */
  onSelectTask?: () => void;
  /** Close Office's own task pane while a shell-owned panel is open. */
  hostPanelOpen?: boolean;
  onOpenReview?: (beadId: string) => void;
  onOpenBatch?: (batchId: string) => void;
  /** Opens Chat when its dock is hidden: the orchestrator has no task, so its character goes to the conversation instead of a side pane. */
  onOpenChat?: () => void;
  /** Lets the shell keep the Office view open when a Needs question is selected in the dock. */
  onChatDockChange?: (docked: boolean) => void;
  /** The shell-owned Chat element to dock beside the room when the measured content width allows it. */
  chatDock?: ReactNode;
  /** The counts the room's objects show and where each object's button goes. */
  roomProps?: OfficeRoomProps;
  /** Number of open questions, passed separately so the Pixi character cue does not inspect overlay structure. */
  openQuestionCount?: number;
}

/**
 * The Office view: the main open-plan room with one pixel-art character per running session, fed by the daemon's
 * `office` websocket messages. Desks are assigned per session the first time it is seen, so a character does not move
 * when another session arrives or leaves. A click opens the character's task in the same side pane the Board shows,
 * over the room, without navigating away; the orchestrator has no task, so its character closes any open side pane,
 * focuses docked Chat when it is visible and opens Chat otherwise.
 * One-shot `office_milestone` inputs draw temporary overlays; they are not part of the session snapshot and are not replayed.
 *
 * `sessions` is null until the first snapshot arrives: the room then draws no characters and no note, so an unloaded
 * office is never mistaken for an empty one. While `offline` (or `stale`, the gap between a reconnect and the snapshot
 * that follows it) the room keeps the last-known set, dimmed and frozen, and the note says the feed is unavailable; the
 * snapshot on reconnect replaces the set, so a gone session walks out and a new one walks in. The empty note is shown
 * only once a snapshot has arrived and named no sessions.
 *
 * The shell keeps this mounted while another view shows (`active` false): its scene frame preserves the characters and
 * desk assignments, and remounting it rebuilt every character and reshuffled the desks. Hidden and paused, a session that
 * ended while away still walks out and one that started walks in on return, while the characters already at their desks
 * do not replay their walk-in.
 */
export function Office({ sessions, milestone = null, onMilestoneConsumed, board = null, version = 0, eventTicks, sceneClock, offline, stale = false, active = true, hostPanelOpen = false, onSelectTask, onOpenReview, onOpenBatch, onOpenChat, onChatDockChange, chatDock, roomProps, openQuestionCount = 0 }: OfficeProps) {
  const reduced = usePrefersReducedMotion();
  const phone = usePhoneLayout();
  const hidden = useDocumentHidden();
  const unavailable = offline || stale;
  const [frame, setFrame] = useState<SceneFrame>(() => deriveScene(null, null));
  const [nightShare, setNightShare] = useState(() => active && !hidden ? SceneSim.nightShare(sceneClock) : 0);
  const [selected, setSelected] = useState<string | null>(null);
  /** The phone card's session id: one card at a time. */
  const [card, setCard] = useState<string | null>(null);
  const repoOrder = useMemo(() => boardRepoOrder(board), [board]);
  const [officeEffects, setOfficeEffects] = useState<OfficeEffects>({ printer: null, review: null, merged: null });
  const pixiEffects = useMemo<OfficeSceneEffects>(() => ({ printer: officeEffects.printer, merged: officeEffects.merged }), [officeEffects.printer, officeEffects.merged]);
  const milestoneTimers = useRef(new Map<OfficeEffectTarget, number>());
  const milestoneSequence = useRef(0);
  const handledMilestone = useRef<OfficeMilestoneMessage | null>(null);
  const frameRef = useRef(frame);
  const officeRef = useRef<HTMLDivElement | null>(null);
  const content = useOfficeContentSize(officeRef);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const paneOpenerId = useRef<string | null>(null);
  const cardOpenerId = useRef<string | null>(null);
  const focusOfficeOpener = useCallback((sessionId: string | null) => {
    const stage = stageRef.current;
    if (!stage) return;
    const agent = frameRef.current.agents.find((candidate) => candidate.id === sessionId && candidate.pose !== 'leaving');
    const character = agent && [...stage.querySelectorAll<HTMLButtonElement>('.office-pixi-char')]
      .find((button) => button.dataset.agentId === sessionId);
    (character ?? stage).focus({ preventScroll: true });
  }, []);
  const closeTaskPane = useCallback(() => {
    setSelected(null);
    focusOfficeOpener(paneOpenerId.current);
  }, [focusOfficeOpener]);
  const closePhoneCard = useCallback((deferFocus = false) => {
    const openerId = cardOpenerId.current;
    setCard(null);
    if (deferFocus) window.setTimeout(() => focusOfficeOpener(openerId), 0);
    else focusOfficeOpener(openerId);
  }, [focusOfficeOpener]);
  const stage = useStageSize(stageRef);
  const showChatDock = active && chatDock !== undefined && stage.width >= CHAT_DOCK_MIN_STAGE && content.width >= stage.width + 380;
  useEffect(() => { onChatDockChange?.(showChatDock); }, [onChatDockChange, showChatDock]);
  useEffect(() => { try { localStorage.removeItem(LEGACY_OFFICE_RENDERER_KEY); } catch { /* storage unavailable */ } }, []);
  const focusChatDock = () => {
    onSelectTask?.();
    setSelected(null);
    const dock = officeRef.current?.querySelector('.office-chat-dock');
    dock?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the orchestrator"]')?.focus();
    const thread = dock?.querySelector<HTMLElement>('.thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  };

  useEffect(() => {
    if (!milestone || handledMilestone.current === milestone) return;
    handledMilestone.current = milestone;
    if (!active || hidden) { onMilestoneConsumed?.(milestone); return; }

    const target = effectTarget(milestone.kind);
    const effect: ActiveOfficeEffect = { id: ++milestoneSequence.current, kind: milestone.kind, startedAt: performance.now(), beadId: milestone.bead_id, reduced };
    const previousTimer = milestoneTimers.current.get(target);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    setOfficeEffects((previous) => ({ ...previous, [target]: effect }));

    let timer: number;
    timer = window.setTimeout(() => {
      if (milestoneTimers.current.get(target) === timer) milestoneTimers.current.delete(target);
      setOfficeEffects((previous) => previous[target]?.id === effect.id ? { ...previous, [target]: null } : previous);
    }, effectDuration(milestone.kind, reduced));
    milestoneTimers.current.set(target, timer);
    onMilestoneConsumed?.(milestone);
  }, [active, hidden, milestone, onMilestoneConsumed, reduced]);

  useEffect(() => () => {
    for (const timer of milestoneTimers.current.values()) window.clearTimeout(timer);
    milestoneTimers.current.clear();
    handledMilestone.current = null;
  }, []);

  useLayoutEffect(() => {
    let next = deriveScene(sessions, board, { previous: frameRef.current, stale, reducedMotion: reduced });
    if (reduced) next = SceneSim.step(next, 0, performance.now());
    frameRef.current = next;
    setFrame(next);
  }, [sessions, board, stale, reduced]);

  useEffect(() => {
    if (hidden || !active) return;
    const refreshLighting = () => setNightShare(SceneSim.nightShare(sceneClock));
    refreshLighting();
    const timer = window.setInterval(refreshLighting, LIGHTING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [sceneClock, hidden, active]);

  useEffect(() => { if (hostPanelOpen) setSelected(null); }, [hostPanelOpen]);

  const review = officeEffects.review;
  // Keyed on the values, not the object the shell rebuilds on every render, so the scene redraws only on a change.
  const sceneRoomProps = useMemo(
    () => (roomProps ? roomPropsInput(roomProps, review ? { id: review.id, startedAt: review.startedAt } : null) : null),
    [roomProps === undefined, roomProps?.questions, roomProps?.reviewBatches, roomProps?.columns, review],
  );
  const openTarget = (agent: Agent): { onOpen?: () => void; opens?: string } => {
    const isOrchestrator = !agent.beadId && agent.role === 'orchestrator';
    const focusesChat = isOrchestrator && showChatDock;
    const opensChat = isOrchestrator && !showChatDock && onOpenChat !== undefined;
    const onOpen = agent.beadId ? () => { paneOpenerId.current = agent.id; onSelectTask?.(); setSelected(agent.beadId!); } : focusesChat ? focusChatDock : opensChat ? onOpenChat : undefined;
    const opens = focusesChat ? 'focus Chat' : opensChat ? 'opens Chat' : undefined;
    return { onOpen, opens };
  };
  // On a phone a tap opens the character's card; the card's link then does what a desktop click does (openTarget).
  const openerFor = phone ? (agent: Agent) => ({ onOpen: () => { cardOpenerId.current = agent.id; setCard(agent.id); }, opens: 'shows details' }) : openTarget;
  const cardAgent = phone && card ? frame.agents.find((agent) => agent.id === card && agent.pose !== 'leaving') : undefined;
  const cardTarget = cardAgent ? openTarget(cardAgent) : null;
  useEffect(() => {
    if (!card || cardAgent) return;
    setCard(null);
    focusOfficeOpener(cardOpenerId.current);
  }, [card, cardAgent, focusOfficeOpener]);
  useEffect(() => {
    if (!cardAgent) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closePhoneCard(); };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.office-card, .office-badge, .office-pixi-char')) return;
      closePhoneCard(true);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [cardAgent, closePhoneCard]);

  return (
    <div
      className={`office${showChatDock ? ' office-with-chat' : ''}${unavailable ? ' office-reconnecting' : ''}`}
      ref={officeRef}
      style={{ '--office-stage-width': `${officeStageMaxWidth(content.height)}px`, '--office-height': `${content.height}px` } as CSSProperties}
    >
      <OfficeStage
        frameRef={frameRef}
        frame={frame}
        stageRef={stageRef}
        running={!reduced && !hidden && !unavailable && active}
        unavailable={unavailable}
        reduced={reduced}
        nightShare={nightShare}
        effects={pixiEffects}
        asking={openQuestionCount > 0}
        onFrame={setFrame}
        openerFor={openerFor}
        badgeRepoOrder={phone ? repoOrder : undefined}
        roomPropsInput={sceneRoomProps}
        roomProps={roomProps}
        roomPropButtons={!phone}
        nameTags={!captureMode()}
      />
      {phone && <BadgeKey agents={frame.agents} repoOrder={repoOrder} />}
      {phone && roomProps && <OfficeCountRow props={roomProps} />}
      {unavailable && <p className="office-empty office-unavailable">{OFFICE_UNAVAILABLE_NOTE}</p>}
      {!unavailable && frame.props.hasSnapshot && frame.agents.length === 0 && <p className="office-empty">{OFFICE_EMPTY_NOTE}</p>}
      {cardAgent && (
        <AgentCard agent={cardAgent} board={board} repoOrder={repoOrder} onClose={() => closePhoneCard()}
          link={cardTarget?.onOpen ? { text: cardAgent.beadId ? `Open task ${cardAgent.beadId}` : 'Open Chat', onOpen: () => { setCard(null); cardTarget.onOpen!(); } } : null} />
      )}
      {showChatDock && <aside className="office-chat-dock" aria-label="Chat">{chatDock}</aside>}
      {selected && frame.props.board && (
        <TaskPane
          beadId={selected}
          board={frame.props.board}
          version={version}
          eventTicks={eventTicks}
          offline={offline}
          onSelect={setSelected}
          onClose={closeTaskPane}
          onOpenReview={(id) => onOpenReview?.(id)}
          onOpenBatch={(id) => { setSelected(null); onOpenBatch?.(id); }}
        />
      )}
    </div>
  );
}
