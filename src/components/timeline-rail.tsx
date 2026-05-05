"use client";

import React, { useMemo, useRef } from "react";
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

const PX_PER_BEAT = 44;
const MIN_BEATS = 1;
const MIN_REEL_SECONDS = 8;
const MAX_REEL_SECONDS = 30;
const RAIL_PADDING_X = 16;

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
}: TimelineRailProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const trackRef = useRef<HTMLDivElement>(null);

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

  const railWidthPx = Math.max(totalBeats, 1) * PX_PER_BEAT;

  const playheadPx = useMemo(() => {
    if (timeline.length === 0 || totalDurationFrames <= 0) return 0;
    const slotPx: number[] = perSlotFrames.map((_, i) => {
      const item = timeline[i];
      const beats =
        item?.beats ??
        (item?.kind === "video" && item?.durationSeconds && beatPeriodSeconds
          ? Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds))
          : 2);
      return beats * PX_PER_BEAT;
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
      const slotPx = beats * PX_PER_BEAT;
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
    return (
      <div className="rounded-[24px] border border-dashed border-[var(--line)] bg-white/40 px-6 py-10 text-center text-sm leading-6 text-[var(--muted)]">
        Drop photos and clips above. They&apos;ll appear here as draggable beat-locked
        blocks.
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
          <span className="font-mono text-xs text-[var(--muted)]">
            ▶ {(currentFrame / fps).toFixed(2)}s
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
        className="overflow-x-auto rounded-[24px] border border-white/5 bg-[#0f172a] p-4"
        style={{ paddingLeft: RAIL_PADDING_X, paddingRight: RAIL_PADDING_X }}
      >
        {beatPeriodSeconds ? (
          <div
            className="relative cursor-pointer"
            onClick={handleRailClick}
            ref={trackRef}
            style={{ minWidth: `${railWidthPx}px` }}
          >
            <BeatTickRail
              beatPeriodSeconds={beatPeriodSeconds}
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
                  className="mt-2 flex gap-1"
                  style={{
                    minWidth: beatsCommitted ? `${railWidthPx}px` : undefined,
                  }}
                >
                  {timeline.map((item, index) => (
                    <SortableClip
                      beatPeriodSeconds={beatPeriodSeconds}
                      index={index}
                      item={item}
                      key={item.id}
                      onCaptionChange={onCaptionChange}
                      onRemove={onRemove}
                      onSetTrim={onSetTrim}
                      totalSecondsClamp={clamp}
                    />
                  ))}
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
};

function BeatTickRail({ totalBeats, beatPeriodSeconds }: BeatTickRailProps) {
  const ticks = Array.from({ length: totalBeats + 1 }, (_, i) => i);
  return (
    <div
      className="relative h-6 select-none border-b border-white/10"
      style={{ width: `${totalBeats * PX_PER_BEAT}px` }}
    >
      {ticks.map((i) => (
        <div
          key={i}
          className="absolute top-0 bottom-0 flex flex-col items-center"
          style={{ left: `${i * PX_PER_BEAT}px`, transform: "translateX(-50%)" }}
        >
          <div
            className={`w-px ${i % 4 === 0 ? "h-5 bg-emerald-300" : "h-3 bg-white/30"}`}
          />
          {i % 4 === 0 ? (
            <span className="mt-0.5 text-[10px] font-mono text-emerald-300/80">
              {(i * beatPeriodSeconds).toFixed(1)}s
            </span>
          ) : null}
        </div>
      ))}
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
  onCaptionChange: (id: string, text: string) => void;
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
  onCaptionChange,
}: SortableClipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const beats =
    item.beats ??
    (item.kind === "video" && item.durationSeconds && beatPeriodSeconds
      ? Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds))
      : 2);
  const videoStartBeats = item.kind === "video" ? item.videoStartBeats ?? 0 : 0;
  const seconds = beatPeriodSeconds ? beats * beatPeriodSeconds : null;
  const widthPx = Math.max(72, beats * PX_PER_BEAT);

  const maxBeats = maxBeatsFor(item, beatPeriodSeconds);
  const reelOver = totalSecondsClamp === "over";
  const tailBeats = Number.isFinite(maxBeats)
    ? Math.max(0, maxBeats - videoStartBeats - beats)
    : 0;
  const atMax = !Number.isFinite(maxBeats) ? false : tailBeats <= 0;
  const atMin = beats <= MIN_BEATS;
  const atFront = videoStartBeats <= 0;

  const headTrimSeconds =
    beatPeriodSeconds && item.kind === "video" ? videoStartBeats * beatPeriodSeconds : 0;
  const tailTrimSeconds =
    beatPeriodSeconds && item.kind === "video" ? tailBeats * beatPeriodSeconds : 0;

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
      const rawDelta = Math.round(dx / PX_PER_BEAT);

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

  const sourceTotal = videoStartBeats + beats + tailBeats;
  const headPct = sourceTotal > 0 ? (videoStartBeats / sourceTotal) * 100 : 0;
  const activePct = sourceTotal > 0 ? (beats / sourceTotal) * 100 : 100;

  return (
    <div
      ref={setNodeRef}
      className="group relative flex shrink-0 flex-col rounded-2xl border border-emerald-400/30 bg-gradient-to-b from-emerald-500/15 to-emerald-500/5 p-2 pl-3 pr-3 text-white"
      style={style}
    >
      <div
        aria-label="Drag left edge to resize"
        className={`absolute left-0 top-0 z-10 flex h-full w-2.5 cursor-ew-resize items-center justify-center rounded-l-2xl bg-emerald-300/20 hover:bg-emerald-300/55 ${atMin && (item.kind !== "video" || atFront) ? "opacity-30" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => startResize("left", e)}
      >
        <span className="h-8 w-0.5 rounded-full bg-emerald-200/80" />
      </div>
      <div
        aria-label="Drag right edge to resize"
        className={`absolute right-0 top-0 z-10 flex h-full w-2.5 cursor-ew-resize items-center justify-center rounded-r-2xl bg-emerald-300/20 hover:bg-emerald-300/55 ${atMax || reelOver ? "opacity-30" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => startResize("right", e)}
      >
        <span className="h-8 w-0.5 rounded-full bg-emerald-200/80" />
      </div>

      <div
        className="flex cursor-grab items-center justify-between gap-1 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <span className="rounded-full bg-emerald-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
          #{index + 1}
        </span>
        <span className="text-[10px] font-mono text-emerald-200/80">
          {beats}b {seconds ? `· ${seconds.toFixed(1)}s` : ""}
        </span>
      </div>

      <div className="relative mt-2 h-16 w-full overflow-hidden rounded-xl bg-black/40">
        {item.kind === "video" ? (
          <video
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
            src={item.src}
          />
        ) : (
          <img alt={item.name} className="h-full w-full object-cover" src={item.src} />
        )}
        {item.scene ? (
          <span className="absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-200">
            {item.scene}
          </span>
        ) : null}
      </div>

      {item.kind === "video" && Number.isFinite(maxBeats) ? (
        <div className="mt-1.5">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full bg-zinc-500/50"
              style={{ width: `${headPct}%` }}
              title={`Trimmed front: ${headTrimSeconds.toFixed(1)}s`}
            />
            <div
              className="h-full bg-emerald-300/85"
              style={{ width: `${activePct}%` }}
              title={`Active: ${(beats * (beatPeriodSeconds ?? 0)).toFixed(1)}s`}
            />
            <div
              className="h-full bg-zinc-500/50"
              style={{ width: `${100 - headPct - activePct}%` }}
              title={`Trimmed tail: ${tailTrimSeconds.toFixed(1)}s`}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-[9px] font-mono leading-3 text-emerald-200/70">
            <span>{headTrimSeconds > 0 ? `↤ ${headTrimSeconds.toFixed(1)}s` : ""}</span>
            <span>
              {tailTrimSeconds > 0 ? `${tailTrimSeconds.toFixed(1)}s ↦` : ""}
            </span>
          </div>
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end">
        <button
          aria-label="Remove"
          className="rounded-md bg-white/10 px-2 py-0.5 text-xs text-rose-200 hover:bg-rose-500/30"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id);
          }}
          type="button"
        >
          ✕
        </button>
      </div>

      <input
        className="mt-2 w-full rounded-md bg-white/5 px-2 py-1 text-[11px] text-emerald-50 placeholder:text-emerald-50/40"
        onChange={(e) => onCaptionChange(item.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder="Caption…"
        type="text"
        value={item.caption ?? ""}
      />
    </div>
  );
}
