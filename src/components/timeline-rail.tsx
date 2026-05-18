"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

// useLayoutEffect logs an SSR warning on the server. Client component but
// Next.js still renders it during the server pass.
const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TimelineMedia } from "@/lib/media";
import type { Overlay } from "@/lib/overlays";

// Floor pixel density so trim handles stay reachable when the timeline is very
// long. Above this, "zoom = 1" means the whole reel fits the rail width;
// zoom > 1 scales up and the container scrolls horizontally.
const PX_PER_BEAT_FLOOR = 8;
const MIN_BEATS = 1;
const MIN_REEL_SECONDS = 8;
const MAX_REEL_SECONDS = 30;
const RAIL_PADDING_X = 16;
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.5;

export const LIBRARY_DRAG_MIME = "application/x-montaj-library-id";

export type TimelineRailProps = {
  timeline: TimelineMedia[];
  beatPeriodSeconds: number | null;
  fps: number;
  perSlotFrames: number[];
  totalDurationFrames: number;
  transitionFrames: number;
  currentFrame: number;
  onSeek: (frame: number) => void;
  onReorder: (next: TimelineMedia[]) => void;
  onSetTrim: (id: string, startBeats: number, beats: number) => void;
  onRemove: (id: string) => void;
  onCaptionChange: (id: string, text: string) => void;
  onAutoFit: () => void;
  targetSeconds: number;
  onTargetSecondsChange: (seconds: number) => void;
  onLibraryDrop: (libraryId: string, atIndex: number) => void;
  selectedClipId?: string | null;
  onSelectClip?: (id: string | null) => void;
  overlays?: Overlay[];
  selectedOverlayId?: string | null;
  onSelectOverlay?: (id: string | null) => void;
  onOverlayTimingChange?: (
    id: string,
    startSeconds: number,
    durationSeconds: number,
  ) => void;
};

export function TimelineRail({
  timeline,
  beatPeriodSeconds,
  fps,
  perSlotFrames,
  totalDurationFrames,
  transitionFrames,
  currentFrame,
  onSeek,
  onReorder,
  onSetTrim,
  onRemove,
  onCaptionChange,
  onAutoFit,
  targetSeconds,
  onTargetSecondsChange,
  onLibraryDrop,
  selectedClipId,
  onSelectClip,
  overlays,
  selectedOverlayId,
  onSelectOverlay,
  onOverlayTimingChange,
}: TimelineRailProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const trackRef = useRef<HTMLDivElement>(null);
  const clipsRowRef = useRef<HTMLDivElement>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [drop, setDrop] = useState<{ index: number; leftPx: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);

  // Callback ref re-runs whenever the element mounts/unmounts. A plain useRef
  // + useLayoutEffect([]) was wrong here: the empty-timeline branch below
  // returns a *different* element with no ref, so on the first mount
  // containerRef.current was null and the effect bailed. When the rail later
  // appeared, the effect did not re-run, containerWidth stayed at 0, and
  // fitPxPerBeat fell to PX_PER_BEAT_FLOOR — the rail capped at ~400px
  // regardless of the panel width.
  useIsoLayoutEffect(() => {
    if (!containerEl) return;
    const measure = () => setContainerWidth(containerEl.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(containerEl);
    return () => ro.disconnect();
  }, [containerEl]);

  function computeDrop(clientX: number): { index: number; leftPx: number } {
    const row = clipsRowRef.current;
    if (!row) return { index: timeline.length, leftPx: 0 };
    const children = Array.from(row.children).filter(
      (c): c is HTMLElement =>
        c instanceof HTMLElement && !c.dataset.dropIndicator,
    );
    if (children.length === 0) return { index: 0, leftPx: 0 };
    for (let i = 0; i < children.length; i += 1) {
      const rect = children[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return { index: i, leftPx: children[i].offsetLeft };
      }
    }
    const last = children[children.length - 1];
    return { index: children.length, leftPx: last.offsetLeft + last.offsetWidth };
  }

  function handleDragOverRail(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDrop(computeDrop(e.clientX));
  }

  function handleDragLeaveRail(e: React.DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDrop(null);
  }

  function handleDropRail(e: React.DragEvent<HTMLDivElement>) {
    const libraryId = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
    if (!libraryId) return;
    e.preventDefault();
    const { index } = computeDrop(e.clientX);
    setDrop(null);
    onLibraryDrop(libraryId, index);
  }

  const { totalSeconds, totalBeats, targetBeats, effectiveBeats, beatsCommitted } =
    useMemo(() => {
      if (!beatPeriodSeconds) {
        return {
          totalSeconds: 0,
          totalBeats: 0,
          targetBeats: 0,
          effectiveBeats: 1,
          beatsCommitted: false,
        };
      }
      const allHaveBeats = timeline.every((it) => it.beats != null);
      const beats = timeline.reduce((sum, item) => {
        const b =
          item.beats ??
          (item.kind === "video"
            ? Math.max(1, Math.floor((item.durationSeconds ?? 1) / beatPeriodSeconds))
            : 2);
        return sum + b;
      }, 0);
      const tBeats = Math.max(1, Math.ceil(targetSeconds / beatPeriodSeconds));
      return {
        totalSeconds: totalDurationFrames > 0 ? totalDurationFrames / fps : 0,
        totalBeats: beats,
        targetBeats: tBeats,
        // The ruler always spans at least the project's target duration so
        // users see the full project length at zoom=1, even before clips fill
        // it. Clips extending past the target push the ruler wider (and the
        // outer wrapper scrolls).
        effectiveBeats: Math.max(beats, tBeats, 1),
        beatsCommitted: allHaveBeats,
      };
    }, [timeline, beatPeriodSeconds, totalDurationFrames, fps, targetSeconds]);

  const perSlotPlayerStartFrames = useMemo(() => {
    if (perSlotFrames.length === 0) return [] as number[];
    const starts: number[] = new Array(perSlotFrames.length);
    let acc = 0;
    for (let i = 0; i < perSlotFrames.length; i += 1) {
      starts[i] = acc;
      if (i < perSlotFrames.length - 1) {
        const overlap = Math.max(
          2,
          Math.min(
            transitionFrames,
            Math.floor(perSlotFrames[i] / 2),
            Math.floor(perSlotFrames[i + 1] / 2),
          ),
        );
        acc += perSlotFrames[i] - overlap;
      }
    }
    return starts;
  }, [perSlotFrames, transitionFrames]);

  const clamp: "under" | "ok" | "over" = !beatPeriodSeconds
    ? "ok"
    : totalSeconds < MIN_REEL_SECONDS
      ? "under"
      : totalSeconds > MAX_REEL_SECONDS
        ? "over"
        : "ok";

  // Pixel density that fits the entire ruler (target duration, or the clips
  // if they exceed it) into the visible rail. The actual px-per-beat is this
  // value scaled by `zoom`; when zoom > 1 (or when the fit value falls below
  // the floor) the rail becomes wider than the container and the outer
  // wrapper scrolls horizontally. When the container hasn't been measured
  // yet (initial render before useLayoutEffect commits), fall back to the
  // floor so railWidth stays small instead of blowing out.
  const fitPxPerBeat = useMemo(() => {
    const available = Math.max(0, containerWidth - RAIL_PADDING_X * 2);
    if (available === 0 || effectiveBeats <= 0) return PX_PER_BEAT_FLOOR;
    return Math.max(PX_PER_BEAT_FLOOR, available / effectiveBeats);
  }, [containerWidth, effectiveBeats]);

  const pxPerBeat = fitPxPerBeat * zoom;
  const railWidthPx = effectiveBeats * pxPerBeat;
  const targetMarkerPx = targetBeats * pxPerBeat;

  const playheadPx = useMemo(() => {
    if (timeline.length === 0 || totalDurationFrames <= 0) return 0;
    const slotPx: number[] = perSlotFrames.map((_, i) => {
      const item = timeline[i];
      const beats =
        item?.beats ??
        (item?.kind === "video" && item?.durationSeconds && beatPeriodSeconds
          ? Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds))
          : 2);
      return beats * pxPerBeat;
    });
    let pxAcc = 0;
    for (let i = 0; i < perSlotFrames.length; i += 1) {
      const start = perSlotPlayerStartFrames[i] ?? 0;
      const nextStart = perSlotPlayerStartFrames[i + 1] ?? Number.POSITIVE_INFINITY;
      if (currentFrame < nextStart) {
        const within = Math.min(1, Math.max(0, (currentFrame - start) / perSlotFrames[i]));
        return pxAcc + within * slotPx[i];
      }
      pxAcc += slotPx[i];
    }
    // Past the last clip: park the playhead at the clip-row end rather than
    // the ruler end (those differ when target duration exceeds clip sum).
    return pxAcc;
  }, [
    currentFrame,
    perSlotFrames,
    perSlotPlayerStartFrames,
    timeline,
    beatPeriodSeconds,
    pxPerBeat,
    totalDurationFrames,
  ]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = timeline.findIndex((it) => it.id === active.id);
    const newIndex = timeline.findIndex((it) => it.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(timeline, oldIndex, newIndex));
  }

  function handleRailClick(event: React.MouseEvent<HTMLDivElement>) {
    if (totalDurationFrames <= 0 || timeline.length === 0) return;
    const rail = trackRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const xInRail = event.clientX - rect.left;
    if (xInRail < 0 || xInRail > rect.width) return;

    let pxAcc = 0;
    for (let i = 0; i < timeline.length; i += 1) {
      const item = timeline[i];
      const beats =
        item.beats ??
        (item.kind === "video" && item.durationSeconds && beatPeriodSeconds
          ? Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds))
          : 2);
      const slotPx = beats * pxPerBeat;
      if (xInRail < pxAcc + slotPx) {
        const within = (xInRail - pxAcc) / slotPx;
        const start = perSlotPlayerStartFrames[i] ?? 0;
        onSeek(start + within * perSlotFrames[i]);
        return;
      }
      pxAcc += slotPx;
    }
    onSeek(Math.max(0, totalDurationFrames - 1));
  }

  if (timeline.length === 0) {
    const isHovering = drop !== null;
    return (
      <div
        className={`rounded-[24px] border-2 border-dashed px-6 py-10 text-center text-sm leading-6 transition ${
          isHovering
            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
            : "border-[var(--line)] bg-white/40 text-[var(--muted)]"
        }`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDrop({ index: 0, leftPx: 0 });
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDrop(null);
        }}
        onDrop={(e) => {
          const libraryId = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
          if (!libraryId) return;
          e.preventDefault();
          setDrop(null);
          onLibraryDrop(libraryId, 0);
        }}
      >
        {isHovering ? "Drop to add to the reel" : "Drag clips here from the upload list to start your reel."}
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-xs leading-5">
        <div className="flex items-center gap-3">
          <span className="font-medium text-[var(--ink-soft)]">
            Total {totalSeconds ? `${totalSeconds.toFixed(1)}s` : "—"}
          </span>
          <span className="text-[var(--muted)]">
            {totalBeats} beats · target {targetSeconds}s
          </span>
          {clamp === "under" ? (
            <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              Under {MIN_REEL_SECONDS}s
            </span>
          ) : null}
          {clamp === "over" ? (
            <span className="rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
              Over {MAX_REEL_SECONDS}s
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-[var(--muted)]">Target</span>
            <input
              className="w-28"
              max={MAX_REEL_SECONDS}
              min={MIN_REEL_SECONDS}
              onChange={(e) => onTargetSecondsChange(Number(e.target.value))}
              type="range"
              value={targetSeconds}
            />
            <span className="w-8 text-right font-medium text-[var(--ink-soft)]">
              {targetSeconds}s
            </span>
          </label>
          <button
            className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white transition hover:bg-[var(--accent-strong)] disabled:opacity-50"
            disabled={!beatPeriodSeconds || timeline.length === 0}
            onClick={onAutoFit}
            type="button"
          >
            Auto-fit
          </button>
          <div className="flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-1 py-0.5">
            <button
              aria-label="Zoom out"
              className="rounded px-1.5 text-[var(--ink-soft)] transition hover:bg-[var(--panel-soft)] disabled:opacity-40"
              disabled={zoom <= MIN_ZOOM + 0.001}
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
              type="button"
            >
              −
            </button>
            <button
              className="px-1 font-mono text-[10px] tabular-nums text-[var(--muted)] hover:text-[var(--ink)]"
              onClick={() => setZoom(1)}
              title="Fit to width"
              type="button"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              aria-label="Zoom in"
              className="rounded px-1.5 text-[var(--ink-soft)] transition hover:bg-[var(--panel-soft)] disabled:opacity-40"
              disabled={zoom >= MAX_ZOOM - 0.001}
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
              type="button"
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div
        className="overflow-x-auto overflow-y-hidden rounded-[24px] border border-[var(--line)] bg-white/60 p-4"
        onDragLeave={handleDragLeaveRail}
        onDragOver={handleDragOverRail}
        onDrop={handleDropRail}
        ref={setContainerEl}
        style={{ paddingLeft: RAIL_PADDING_X, paddingRight: RAIL_PADDING_X }}
      >
        {beatPeriodSeconds ? (
          <div
            className="relative cursor-pointer"
            onClick={handleRailClick}
            ref={trackRef}
            style={{ width: `${railWidthPx}px` }}
          >
            <BeatTickRail
              beatPeriodSeconds={beatPeriodSeconds}
              pxPerBeat={pxPerBeat}
              totalBeats={effectiveBeats}
            />

            {targetBeats > 0 && targetBeats < effectiveBeats ? (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 z-10 border-l-2 border-dashed border-[var(--accent)]/55"
                style={{ left: `${targetMarkerPx}px` }}
              >
                <span className="absolute -top-1 left-1 rounded bg-[var(--accent)] px-1 py-0.5 font-mono text-[9px] font-medium tracking-wide text-white">
                  {targetSeconds}s
                </span>
              </div>
            ) : null}

            <DndContext
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              sensors={sensors}
            >
              <SortableContext
                items={timeline.map((it) => it.id)}
                strategy={horizontalListSortingStrategy}
              >
                <div
                  className="relative mt-2 flex gap-1"
                  ref={clipsRowRef}
                  style={{
                    width: beatsCommitted ? `${railWidthPx}px` : undefined,
                  }}
                >
                  {timeline.map((item, index) => (
                    <SortableClip
                      beatPeriodSeconds={beatPeriodSeconds}
                      index={index}
                      isSelected={selectedClipId === item.id}
                      item={item}
                      key={item.id}
                      onRemove={onRemove}
                      onSelect={onSelectClip}
                      onSetTrim={onSetTrim}
                      pxPerBeat={pxPerBeat}
                      totalSecondsClamp={clamp}
                    />
                  ))}
                  {drop !== null ? <DropIndicator leftPx={drop.leftPx} /> : null}
                </div>
              </SortableContext>
            </DndContext>

            {overlays && overlays.length > 0 && beatPeriodSeconds ? (
              <OverlayTrack
                onSelectOverlay={onSelectOverlay}
                onTimingChange={onOverlayTimingChange}
                overlays={overlays}
                pxPerSecond={pxPerBeat / beatPeriodSeconds}
                railWidthPx={railWidthPx}
                selectedOverlayId={selectedOverlayId}
              />
            ) : null}

            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-[var(--accent)]"
              style={{ left: `${playheadPx}px` }}
            >
              <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-[var(--accent)]" />
            </div>
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)]">
            Detecting BPM — beat grid will appear once analysis completes.
          </p>
        )}
      </div>
    </div>
  );
}

type BeatTickRailProps = {
  totalBeats: number;
  beatPeriodSeconds: number;
  pxPerBeat: number;
};

function BeatTickRail({ totalBeats, beatPeriodSeconds, pxPerBeat }: BeatTickRailProps) {
  // Skip labels when they'd overlap (small pxPerBeat). Show every Nth beat.
  const labelEveryN = Math.max(4, Math.ceil(40 / pxPerBeat));
  const ticks = Array.from({ length: totalBeats + 1 }, (_, i) => i);
  return (
    <div
      className="relative h-6 select-none border-b border-[var(--line)]"
      style={{ width: `${totalBeats * pxPerBeat}px` }}
    >
      {ticks.map((i) => {
        const isLabel = i % labelEveryN === 0;
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0 flex flex-col items-center"
            style={{ left: `${i * pxPerBeat}px`, transform: "translateX(-50%)" }}
          >
            <div
              className={`w-px ${isLabel ? "h-5 bg-[var(--accent)]" : "h-3 bg-[var(--muted)]/40"}`}
            />
            {isLabel ? (
              <span className="mt-0.5 text-[10px] font-mono text-[var(--muted)]">
                {(i * beatPeriodSeconds).toFixed(1)}s
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type SortableClipProps = {
  item: TimelineMedia;
  index: number;
  beatPeriodSeconds: number | null;
  totalSecondsClamp: "under" | "ok" | "over";
  onSetTrim: (id: string, startBeats: number, beats: number) => void;
  onRemove: (id: string) => void;
  pxPerBeat: number;
  isSelected: boolean;
  onSelect?: (id: string | null) => void;
};

function maxBeatsFor(
  item: TimelineMedia,
  beatPeriodSeconds: number | null,
): number {
  if (item.kind !== "video") return Number.POSITIVE_INFINITY;
  if (!beatPeriodSeconds || !item.durationSeconds) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds));
}

function SortableClip({
  item,
  index,
  beatPeriodSeconds,
  totalSecondsClamp,
  onSetTrim,
  onRemove,
  pxPerBeat,
  isSelected,
  onSelect,
}: SortableClipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const beats =
    item.beats ??
    (item.kind === "video" && item.durationSeconds && beatPeriodSeconds
      ? Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds))
      : 2);
  const videoStartBeats = item.kind === "video" ? item.videoStartBeats ?? 0 : 0;
  const widthPx = Math.max(36, beats * pxPerBeat);

  const maxBeats = maxBeatsFor(item, beatPeriodSeconds);
  const reelOver = totalSecondsClamp === "over";
  const tailBeats = Number.isFinite(maxBeats)
    ? Math.max(0, maxBeats - videoStartBeats - beats)
    : 0;
  const atMax = !Number.isFinite(maxBeats) ? false : tailBeats <= 0;
  const atMin = beats <= MIN_BEATS;
  const atFront = videoStartBeats <= 0;

  function startResize(side: "left" | "right", e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const startX = e.clientX;
    const startBeats = beats;
    const startVideoStartBeats = videoStartBeats;
    target.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const rawDelta = Math.round(dx / pxPerBeat);

      if (side === "right") {
        let want = startBeats + rawDelta;
        if (Number.isFinite(maxBeats)) {
          want = Math.min(want, maxBeats - startVideoStartBeats);
        }
        const safeBeats = Math.max(MIN_BEATS, want);
        if (safeBeats !== beats) {
          onSetTrim(item.id, startVideoStartBeats, safeBeats);
        }
      } else if (item.kind === "video") {
        // left edge of a video: shift videoStartBeats; keep right edge fixed
        let wantStart = Math.max(0, startVideoStartBeats + rawDelta);
        if (Number.isFinite(maxBeats)) {
          wantStart = Math.min(wantStart, maxBeats - 1);
        }
        const newBeats = Math.max(
          MIN_BEATS,
          startBeats + (startVideoStartBeats - wantStart),
        );
        if (wantStart !== videoStartBeats || newBeats !== beats) {
          onSetTrim(item.id, wantStart, newBeats);
        }
      } else {
        // image: left-edge drag mirrors right-edge for resize
        const safeBeats = Math.max(MIN_BEATS, startBeats - rawDelta);
        if (safeBeats !== beats) {
          onSetTrim(item.id, 0, safeBeats);
        }
      }
    };
    const end = (ev: PointerEvent) => {
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        // already released
      }
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.65 : 1,
    width: `${widthPx}px`,
  } as const;

  return (
    <div
      ref={setNodeRef}
      className={`group relative flex h-16 shrink-0 overflow-hidden rounded-md border bg-[var(--panel-soft)] text-[var(--ink-soft)] transition ${
        isSelected
          ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/40"
          : "border-[var(--line)]"
      }`}
      onClick={(e) => {
        // Don't intercept clicks on the trim handles or remove button.
        if ((e.target as HTMLElement).closest("[data-no-select]")) return;
        e.stopPropagation();
        onSelect?.(isSelected ? null : item.id);
      }}
      style={style}
    >
      {item.kind === "video" && item.previewFrames && item.previewFrames.length > 0 ? (
        <Filmstrip frames={item.previewFrames} />
      ) : item.kind === "image" ? (
        <img alt={item.name} className="h-full w-full object-cover" draggable={false} src={item.src} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] text-[var(--muted)]">
          Loading…
        </div>
      )}

      <div
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
      />

      <div className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-black/40 px-1 text-[9px] font-mono text-white/90">
        #{index + 1}
      </div>
      <button
        aria-label="Remove"
        className="absolute right-1 top-1 z-20 rounded bg-black/40 px-1 text-[10px] text-white/90 opacity-0 transition hover:bg-rose-500/80 group-hover:opacity-100"
        data-no-select
        onClick={(e) => {
          e.stopPropagation();
          onRemove(item.id);
        }}
        type="button"
      >
        ✕
      </button>

      <div
        aria-label="Drag left edge to resize"
        className={`absolute left-0 top-0 z-30 flex h-full w-2 cursor-ew-resize items-center justify-center bg-[var(--accent)]/35 hover:bg-[var(--accent)]/65 ${atMin && (item.kind !== "video" || atFront) ? "opacity-30" : ""}`}
        data-no-select
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => startResize("left", e)}
      >
        <span className="h-6 w-0.5 rounded-full bg-white/90" />
      </div>
      <div
        aria-label="Drag right edge to resize"
        className={`absolute right-0 top-0 z-30 flex h-full w-2 cursor-ew-resize items-center justify-center bg-[var(--accent)]/35 hover:bg-[var(--accent)]/65 ${atMax || reelOver ? "opacity-30" : ""}`}
        data-no-select
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => startResize("right", e)}
      >
        <span className="h-6 w-0.5 rounded-full bg-white/90" />
      </div>
    </div>
  );
}

function Filmstrip({ frames }: { frames: string[] }) {
  // Pick a fixed cell count; the cells fill clip width via flex.
  // Sample evenly from the available frames.
  const cells = 8;
  return (
    <div className="flex h-full w-full">
      {Array.from({ length: cells }, (_, i) => {
        const frameIdx = Math.min(
          frames.length - 1,
          Math.floor((i / Math.max(1, cells - 1)) * (frames.length - 1)),
        );
        return (
          <img
            alt=""
            className="h-full min-w-0 flex-1 object-cover"
            draggable={false}
            key={i}
            src={frames[frameIdx]}
          />
        );
      })}
    </div>
  );
}

function DropIndicator({ leftPx }: { leftPx: number }) {
  return (
    <div
      data-drop-indicator
      className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 -translate-x-1/2 rounded-full bg-[var(--accent)]"
      style={{ left: `${leftPx}px` }}
    />
  );
}

type OverlayTrackProps = {
  overlays: Overlay[];
  pxPerSecond: number;
  railWidthPx: number;
  selectedOverlayId?: string | null;
  onSelectOverlay?: (id: string | null) => void;
  onTimingChange?: (
    id: string,
    startSeconds: number,
    durationSeconds: number,
  ) => void;
};

function OverlayTrack({
  overlays,
  pxPerSecond,
  railWidthPx,
  selectedOverlayId,
  onSelectOverlay,
  onTimingChange,
}: OverlayTrackProps) {
  return (
    <div
      className="relative mt-3 h-9"
      data-overlay-track
      style={{ width: `${railWidthPx}px` }}
    >
      {overlays.map((overlay) => (
        <OverlayBar
          isSelected={selectedOverlayId === overlay.id}
          key={overlay.id}
          onSelect={onSelectOverlay}
          onTimingChange={onTimingChange}
          overlay={overlay}
          pxPerSecond={pxPerSecond}
        />
      ))}
    </div>
  );
}

type OverlayBarProps = {
  overlay: Overlay;
  pxPerSecond: number;
  isSelected: boolean;
  onSelect?: (id: string | null) => void;
  onTimingChange?: (
    id: string,
    startSeconds: number,
    durationSeconds: number,
  ) => void;
};

function OverlayBar({
  overlay,
  pxPerSecond,
  isSelected,
  onSelect,
  onTimingChange,
}: OverlayBarProps) {
  const dragRef = useRef<{
    mode: "move" | "start" | "end";
    pointerStartX: number;
    initialStart: number;
    initialDuration: number;
  } | null>(null);

  const beginDrag = (
    mode: "move" | "start" | "end",
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      pointerStartX: e.clientX,
      initialStart: overlay.startSeconds,
      initialDuration: overlay.durationSeconds,
    };
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !onTimingChange || pxPerSecond <= 0) return;
    const deltaSeconds = (e.clientX - drag.pointerStartX) / pxPerSecond;
    if (drag.mode === "move") {
      onTimingChange(
        overlay.id,
        Math.max(0, drag.initialStart + deltaSeconds),
        drag.initialDuration,
      );
    } else if (drag.mode === "start") {
      // Resize from the left: start moves, end stays put.
      const end = drag.initialStart + drag.initialDuration;
      const nextStart = Math.max(0, Math.min(end - 0.1, drag.initialStart + deltaSeconds));
      onTimingChange(overlay.id, nextStart, end - nextStart);
    } else {
      // Resize from the right: end moves, start stays put.
      const nextDuration = Math.max(0.1, drag.initialDuration + deltaSeconds);
      onTimingChange(overlay.id, drag.initialStart, nextDuration);
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  const leftPx = overlay.startSeconds * pxPerSecond;
  const widthPx = Math.max(8, overlay.durationSeconds * pxPerSecond);

  return (
    <div
      className={`absolute top-0 flex h-9 items-center overflow-hidden rounded-md border text-[11px] font-medium transition select-none ${
        isSelected
          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
          : "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--ink-soft)] hover:border-[var(--line-strong)]"
      }`}
      data-overlay-bar
      data-overlay-id={overlay.id}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(overlay.id);
      }}
      onPointerDown={(e) => beginDrag("move", e)}
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      style={{
        left: `${leftPx}px`,
        width: `${widthPx}px`,
        cursor: "grab",
      }}
    >
      <div
        className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-transparent hover:bg-[var(--accent)]/30"
        data-overlay-handle="start"
        onPointerDown={(e) => beginDrag("start", e)}
        onPointerMove={handleMove}
        onPointerUp={endDrag}
      />
      <div className="pointer-events-none flex w-full items-center gap-1 px-3">
        <span className="text-base leading-none">
          {overlay.kind === "emoji" ? overlay.content : "T"}
        </span>
        <span className="truncate">
          {overlay.kind === "text" ? overlay.content || "Text" : "Emoji"}
        </span>
      </div>
      <div
        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-transparent hover:bg-[var(--accent)]/30"
        data-overlay-handle="end"
        onPointerDown={(e) => beginDrag("end", e)}
        onPointerMove={handleMove}
        onPointerUp={endDrag}
      />
    </div>
  );
}
