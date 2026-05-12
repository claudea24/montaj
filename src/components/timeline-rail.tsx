"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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

const PX_PER_BEAT_MAX = 44;
const PX_PER_BEAT_MIN = 8;
const MIN_BEATS = 1;
const MIN_REEL_SECONDS = 8;
const MAX_REEL_SECONDS = 30;
const RAIL_PADDING_X = 16;

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
}: TimelineRailProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const trackRef = useRef<HTMLDivElement>(null);
  const clipsRowRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ index: number; leftPx: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const { totalSeconds, totalBeats, beatsCommitted } = useMemo(() => {
    if (!beatPeriodSeconds) {
      return { totalSeconds: 0, totalBeats: 0, beatsCommitted: false };
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
    return {
      totalSeconds: totalDurationFrames > 0 ? totalDurationFrames / fps : 0,
      totalBeats: beats,
      beatsCommitted: allHaveBeats,
    };
  }, [timeline, beatPeriodSeconds, totalDurationFrames, fps]);

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

  // Compute px-per-beat so the clip row fits the container without scrolling.
  // Falls back to the max value when content fits naturally; floors to the min
  // so trim handles stay reachable.
  const pxPerBeat = useMemo(() => {
    if (totalBeats <= 0) return PX_PER_BEAT_MAX;
    const available = Math.max(0, containerWidth - RAIL_PADDING_X * 2);
    if (available === 0) return PX_PER_BEAT_MAX;
    const fit = available / totalBeats;
    return Math.max(PX_PER_BEAT_MIN, Math.min(PX_PER_BEAT_MAX, fit));
  }, [containerWidth, totalBeats]);

  const railWidthPx = Math.max(totalBeats, 1) * pxPerBeat;

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
    return railWidthPx;
  }, [
    currentFrame,
    perSlotFrames,
    perSlotPlayerStartFrames,
    timeline,
    beatPeriodSeconds,
    pxPerBeat,
    railWidthPx,
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
            ? "border-[var(--accent)] bg-[#eef9f7] text-[var(--accent-strong)]"
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
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[#f7f4ec] px-4 py-3 text-sm leading-6">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-[var(--accent-strong)]">
            Total {totalSeconds ? `${totalSeconds.toFixed(1)}s` : "—"}
          </span>
          <span className="text-[var(--muted)]">
            ({totalBeats} beats · target {targetSeconds}s)
          </span>
          {clamp === "under" ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              Under {MIN_REEL_SECONDS}s — add or extend clips
            </span>
          ) : null}
          {clamp === "over" ? (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
              Over {MAX_REEL_SECONDS}s — trim or remove
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-[var(--muted)]">Target</span>
            <input
              className="w-32"
              max={MAX_REEL_SECONDS}
              min={MIN_REEL_SECONDS}
              onChange={(e) => onTargetSecondsChange(Number(e.target.value))}
              type="range"
              value={targetSeconds}
            />
            <span className="w-8 text-right font-semibold text-[var(--accent-strong)]">
              {targetSeconds}s
            </span>
          </label>
          <button
            className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong)] disabled:opacity-50"
            disabled={!beatPeriodSeconds || timeline.length === 0}
            onClick={onAutoFit}
            type="button"
          >
            Auto-fit
          </button>
        </div>
      </div>

      <div
        className="overflow-hidden rounded-[24px] border border-white/5 bg-[#0f172a] p-4"
        onDragLeave={handleDragLeaveRail}
        onDragOver={handleDragOverRail}
        onDrop={handleDropRail}
        ref={containerRef}
        style={{ paddingLeft: RAIL_PADDING_X, paddingRight: RAIL_PADDING_X }}
      >
        {beatPeriodSeconds ? (
          <div
            className="relative cursor-pointer"
            onClick={handleRailClick}
            ref={trackRef}
            style={{ width: `${railWidthPx}px`, maxWidth: "100%" }}
          >
            <BeatTickRail
              beatPeriodSeconds={beatPeriodSeconds}
              pxPerBeat={pxPerBeat}
              totalBeats={totalBeats || 1}
            />

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
                      item={item}
                      key={item.id}
                      onRemove={onRemove}
                      onSetTrim={onSetTrim}
                      pxPerBeat={pxPerBeat}
                      totalSecondsClamp={clamp}
                    />
                  ))}
                  {drop !== null ? <DropIndicator leftPx={drop.leftPx} /> : null}
                </div>
              </SortableContext>
            </DndContext>

            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-rose-400 shadow-[0_0_8px_rgba(244,114,182,0.6)]"
              style={{ left: `${playheadPx}px` }}
            >
              <div className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 bg-rose-400" />
            </div>
          </div>
        ) : (
          <p className="text-sm text-emerald-100/70">
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
      className="relative h-6 select-none border-b border-white/10"
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
              className={`w-px ${isLabel ? "h-5 bg-emerald-300" : "h-3 bg-white/30"}`}
            />
            {isLabel ? (
              <span className="mt-0.5 text-[10px] font-mono text-emerald-300/80">
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
      className="group relative flex h-16 shrink-0 overflow-hidden rounded-lg border border-emerald-400/30 bg-black/40 text-white"
      style={style}
    >
      {item.kind === "video" && item.previewFrames && item.previewFrames.length > 0 ? (
        <Filmstrip frames={item.previewFrames} />
      ) : item.kind === "image" ? (
        <img alt={item.name} className="h-full w-full object-cover" draggable={false} src={item.src} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] text-emerald-200/60">
          Loading…
        </div>
      )}

      <div
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
      />

      <div className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-black/55 px-1 text-[9px] font-mono text-emerald-100">
        #{index + 1}
      </div>
      <button
        aria-label="Remove"
        className="absolute right-1 top-1 z-20 rounded bg-black/55 px-1 text-[10px] text-rose-200 opacity-0 transition hover:bg-rose-500/70 hover:text-white group-hover:opacity-100"
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
        className={`absolute left-0 top-0 z-30 flex h-full w-2 cursor-ew-resize items-center justify-center bg-emerald-300/25 hover:bg-emerald-300/60 ${atMin && (item.kind !== "video" || atFront) ? "opacity-30" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => startResize("left", e)}
      >
        <span className="h-6 w-0.5 rounded-full bg-emerald-100/90" />
      </div>
      <div
        aria-label="Drag right edge to resize"
        className={`absolute right-0 top-0 z-30 flex h-full w-2 cursor-ew-resize items-center justify-center bg-emerald-300/25 hover:bg-emerald-300/60 ${atMax || reelOver ? "opacity-30" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => startResize("right", e)}
      >
        <span className="h-6 w-0.5 rounded-full bg-emerald-100/90" />
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
      className="pointer-events-none absolute top-0 bottom-0 z-30 w-1 -translate-x-1/2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.85)]"
      style={{ left: `${leftPx}px` }}
    />
  );
}
