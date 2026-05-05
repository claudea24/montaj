"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { SlideshowComposition } from "@/components/slideshow-composition";
import { TimelineRail } from "@/components/timeline-rail";
import {
  MUSIC_LIBRARY,
  type MusicTrack,
  type TimelineMedia,
  formatBytes,
  getStorageStatus,
  uploadFilesToSupabase,
} from "@/lib/media";
import { detectBeats, type BeatGrid } from "@/lib/beats";
import { imageSrcToDataUrl } from "@/lib/photo-thumb";
import type { AnalysisResult } from "@/lib/ai";

const FPS = 30;
const FALLBACK_SECONDS_PER_IMAGE = 1;
const TRANSITION_FRAMES = 12;
const DEFAULT_TARGET_SECONDS = 15;
const MIN_REEL_SECONDS = 8;
const MAX_REEL_SECONDS = 30;
const MUSIC_LENGTH_SECONDS = 24;

function defaultBeatsFor(item: TimelineMedia, beatPeriodSeconds: number | null): number {
  if (item.kind === "video" && item.durationSeconds && beatPeriodSeconds) {
    return Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds));
  }
  return item.kind === "video" ? 4 : 2;
}

function maxBeatsFor(item: TimelineMedia, beatPeriodSeconds: number | null): number {
  if (item.kind !== "video") return Number.POSITIVE_INFINITY;
  if (!beatPeriodSeconds || !item.durationSeconds) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(item.durationSeconds / beatPeriodSeconds));
}

export function MontajWeekOne() {
  const [timeline, setTimeline] = useState<TimelineMedia[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<MusicTrack>(MUSIC_LIBRARY[0]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>(
    getStorageStatus().configured
      ? "Supabase storage is configured. Uploaded images will also be persisted."
      : "Supabase storage is not configured yet. Images will stay local in the browser for the demo.",
  );

  const [beatGrid, setBeatGrid] = useState<BeatGrid | null>(null);
  const [beatStatusByTrack, setBeatStatusByTrack] = useState<
    Record<string, "running" | "ok" | "error">
  >({});
  const beatStatus: "idle" | "running" | "ok" | "error" =
    beatStatusByTrack[selectedTrack.src] ?? "idle";

  const [targetSeconds, setTargetSeconds] = useState(DEFAULT_TARGET_SECONDS);

  const [aiStatus, setAiStatus] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [aiMessage, setAiMessage] = useState<string>(
    "Auto-pick will score each photo, suggest captions, and order them into a story arc.",
  );

  const playerRef = useRef<PlayerRef>(null);
  const [currentFrame, setCurrentFrame] = useState(0);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const handler = (event: { detail: { frame: number } }) => {
      setCurrentFrame(event.detail.frame);
    };
    player.addEventListener("frameupdate", handler);
    return () => {
      player.removeEventListener("frameupdate", handler);
    };
  }, []);

  const seekTo = useCallback((frame: number) => {
    playerRef.current?.seekTo(Math.max(0, Math.round(frame)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const trackSrc = selectedTrack.src;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBeatStatusByTrack((current) =>
      current[trackSrc] === "running" ? current : { ...current, [trackSrc]: "running" },
    );
    detectBeats(trackSrc)
      .then((grid) => {
        if (cancelled) return;
        setBeatGrid(grid);
        setBeatStatusByTrack((current) => ({ ...current, [trackSrc]: "ok" }));
      })
      .catch(() => {
        if (cancelled) return;
        setBeatStatusByTrack((current) => ({ ...current, [trackSrc]: "error" }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTrack.src]);

  const beatPeriodSeconds =
    beatGrid && beatGrid.bpm > 0 ? 60 / beatGrid.bpm : null;

  const perSlotFrames = useMemo(() => {
    if (timeline.length === 0) return [] as number[];
    return timeline.map((item) => {
      if (item.beats != null && beatPeriodSeconds) {
        return Math.max(1, Math.round(item.beats * beatPeriodSeconds * FPS));
      }
      if (item.kind === "video" && item.durationSeconds && item.durationSeconds > 0) {
        return Math.max(1, Math.round(item.durationSeconds * FPS));
      }
      if (beatPeriodSeconds) {
        return Math.max(1, Math.round(beatPeriodSeconds * 2 * FPS));
      }
      return Math.max(1, Math.round(FALLBACK_SECONDS_PER_IMAGE * FPS));
    });
  }, [timeline, beatPeriodSeconds]);

  const perSlotStartFrames = useMemo(() => {
    if (timeline.length === 0) return [] as number[];
    return timeline.map((item) => {
      if (
        item.kind === "video" &&
        item.videoStartBeats != null &&
        beatPeriodSeconds
      ) {
        return Math.max(0, Math.round(item.videoStartBeats * beatPeriodSeconds * FPS));
      }
      return 0;
    });
  }, [timeline, beatPeriodSeconds]);

  const totalFrames = useMemo(() => {
    if (perSlotFrames.length === 0) return 0;
    let sum = perSlotFrames.reduce((acc, n) => acc + n, 0);
    for (let i = 0; i < perSlotFrames.length - 1; i += 1) {
      const overlap = Math.max(
        2,
        Math.min(
          TRANSITION_FRAMES,
          Math.floor(perSlotFrames[i] / 2),
          Math.floor(perSlotFrames[i + 1] / 2),
        ),
      );
      sum -= overlap;
    }
    return sum;
  }, [perSlotFrames]);
  const durationInFrames =
    timeline.length === 0 ? FPS * 5 : Math.max(totalFrames, 1);
  const totalSeconds = totalFrames / FPS;

  const totalSize = useMemo(
    () => timeline.reduce((sum, item) => sum + item.size, 0),
    [timeline],
  );
  const videoCount = timeline.filter((item) => item.kind === "video").length;

  const captions = useMemo(
    () => timeline.map((item) => item.caption ?? ""),
    [timeline],
  );

  function removeItem(id: string) {
    setTimeline((current) => {
      const removed = current.find((it) => it.id === id);
      if (removed?.src.startsWith("blob:")) {
        URL.revokeObjectURL(removed.src);
      }
      return current.filter((it) => it.id !== id);
    });
  }

  function setCaption(id: string, text: string) {
    setTimeline((current) =>
      current.map((it) => (it.id === id ? { ...it, caption: text } : it)),
    );
  }

  function setTrim(id: string, startBeats: number, beats: number) {
    setTimeline((current) =>
      current.map((it) => {
        if (it.id !== id) return it;
        if (it.kind !== "video") {
          return { ...it, beats: Math.max(1, beats), videoStartBeats: 0 };
        }
        const ceiling = maxBeatsFor(it, beatPeriodSeconds);
        const safeStart = Math.max(0, Math.min(ceiling - 1, Math.round(startBeats)));
        const safeBeats = Math.max(
          1,
          Math.min(ceiling - safeStart, Math.round(beats)),
        );
        return { ...it, videoStartBeats: safeStart, beats: safeBeats };
      }),
    );
  }

  function autoFit() {
    if (!beatPeriodSeconds || timeline.length === 0) return;
    const target = Math.min(MAX_REEL_SECONDS, Math.max(MIN_REEL_SECONDS, targetSeconds));
    const targetBeats = Math.max(timeline.length, Math.round(target / beatPeriodSeconds));
    const base = Math.floor(targetBeats / timeline.length);
    let leftover = targetBeats - base * timeline.length;
    setTimeline((current) =>
      current.map((it) => {
        const ceiling = maxBeatsFor(it, beatPeriodSeconds);
        const wanted = Math.max(1, base + (leftover > 0 ? 1 : 0));
        const beats = Math.min(ceiling, wanted);
        if (leftover > 0) leftover -= 1;
        return { ...it, beats, videoStartBeats: 0 };
      }),
    );
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setIsUploading(true);
    setStatusMessage("Preparing your upload...");

    try {
      const nextTimeline = await uploadFilesToSupabase(files);
      setTimeline((current) => [...current, ...nextTimeline]);
      setStatusMessage(
        getStorageStatus().configured
          ? `Added ${nextTimeline.length} item${nextTimeline.length === 1 ? "" : "s"} and synced them to Supabase Storage.`
          : `Added ${nextTimeline.length} item${nextTimeline.length === 1 ? "" : "s"} locally. Add Supabase env vars when you want persistence.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      setStatusMessage(message);
    } finally {
      setIsUploading(false);
    }
  }

  async function runAIAnalysis() {
    const photos = timeline.filter((it) => it.kind === "image");
    if (photos.length === 0) {
      setAiStatus("error");
      setAiMessage("Add some photos first.");
      return;
    }

    setAiStatus("running");
    setAiMessage(`Analyzing ${photos.length} photo${photos.length === 1 ? "" : "s"}...`);

    try {
      const dataUrls = await Promise.all(
        photos.map(async (p) => ({ id: p.id, name: p.name, dataUrl: await imageSrcToDataUrl(p.src) })),
      );
      const usable = dataUrls.filter(
        (d): d is { id: string; name: string; dataUrl: string } => Boolean(d.dataUrl),
      );

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photos: usable, maxPicks: 12 }),
      });
      if (!response.ok) throw new Error(`API ${response.status}`);

      const result = (await response.json()) as AnalysisResult;
      const itemById = new Map(result.items.map((it) => [it.id, it]));

      setTimeline((current) => {
        const enriched = current.map((it) => {
          const meta = itemById.get(it.id);
          if (!meta) return it;
          return {
            ...it,
            caption: it.caption ?? meta.caption,
            scene: meta.scene,
            qualityScore: meta.qualityScore,
          };
        });

        if (result.orderedIds.length === 0) return enriched;
        const orderIndex = new Map(result.orderedIds.map((id, i) => [id, i]));
        return [...enriched].sort((a, b) => {
          const ai = orderIndex.has(a.id) ? orderIndex.get(a.id)! : Number.POSITIVE_INFINITY;
          const bi = orderIndex.has(b.id) ? orderIndex.get(b.id)! : Number.POSITIVE_INFINITY;
          return ai - bi;
        });
      });

      setAiStatus("ok");
      setAiMessage(
        result.source === "claude"
          ? `Claude Code ranked ${result.items.length} photos and arranged ${result.orderedIds.length} into a narrative.`
          : (result.reason ?? "Heuristic ordering applied."),
      );
    } catch (error) {
      setAiStatus("error");
      setAiMessage(error instanceof Error ? error.message : "Analysis failed.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--accent)]">
            Montaj
          </p>
          <h1 className="text-2xl leading-tight md:text-3xl">
            Beat-locked reel editor
          </h1>
          <p className="text-sm leading-6 text-[var(--muted)]">
            CapCut-style timeline · {MIN_REEL_SECONDS}–{MAX_REEL_SECONDS}s reels ·
            edits snap to the song&apos;s beat grid.
          </p>
        </div>
        <div className="rounded-2xl bg-[#f7f4ec] px-4 py-2 text-xs leading-5 text-[var(--muted)]">
          <p>
            <span className="font-semibold text-[var(--accent-strong)]">
              {timeline.length}
            </span>{" "}
            items · {timeline.length - videoCount} photos · {videoCount} clips ·{" "}
            {formatBytes(totalSize)}
          </p>
          <p>
            <span className="font-semibold text-[var(--accent-strong)]">
              {selectedTrack.name}
            </span>
            {" · "}
            {beatStatus === "running"
              ? "detecting BPM…"
              : beatGrid
                ? `${beatGrid.bpm} BPM`
                : beatStatus === "error"
                  ? "BPM detect failed"
                  : "—"}
            {" · "}
            <span className="font-semibold">{totalSeconds.toFixed(1)}s</span>
          </p>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="rounded-[28px] border border-[var(--line)] bg-[#0b1220] p-3 shadow-[var(--shadow)]">
          <div className="mx-auto max-w-[420px] overflow-hidden rounded-[20px] border border-white/5 bg-black">
            <Player
              acknowledgeRemotionLicense
              autoPlay
              controls
              component={SlideshowComposition}
              compositionWidth={1080}
              compositionHeight={1920}
              durationInFrames={durationInFrames}
              fps={FPS}
              inputProps={{
                images:
                  timeline.length > 0
                    ? timeline
                    : [
                        {
                          id: "placeholder",
                          name: "Placeholder",
                          size: 0,
                          src: "/placeholder/postcard.svg",
                          kind: "image" as const,
                        },
                      ],
                soundtrackSrc: selectedTrack.src,
                soundtrackLoopFrames: Math.round(MUSIC_LENGTH_SECONDS * FPS),
                perSlotFrames: timeline.length > 0 ? perSlotFrames : undefined,
                perSlotStartFrames:
                  timeline.length > 0 ? perSlotStartFrames : undefined,
                fallbackSecondsPerImage: FALLBACK_SECONDS_PER_IMAGE,
                captions: timeline.length > 0 ? captions : undefined,
                transitionFrames: TRANSITION_FRAMES,
              }}
              ref={playerRef}
              style={{ width: "100%", aspectRatio: "9 / 16" }}
            />
          </div>
        </div>

        <aside className="grid gap-4">
          <section className="rounded-[24px] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Upload</h2>
              <label className="cursor-pointer rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[var(--accent-strong)]">
                Choose
                <input
                  accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif,video/quicktime,video/mp4,.mov,.mp4,.m4v"
                  className="hidden"
                  multiple
                  onChange={(event) => void handleFiles(event.target.files)}
                  type="file"
                />
              </label>
            </div>
            <div
              className={`mt-3 rounded-[18px] border-2 border-dashed px-3 py-5 text-center text-xs leading-5 transition ${
                isDragging
                  ? "border-[var(--accent)] bg-[#eef9f7]"
                  : "border-[var(--line)] bg-white/60 text-[var(--muted)]"
              }`}
              onDragLeave={() => setIsDragging(false)}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                void handleFiles(event.dataTransfer.files);
              }}
            >
              {isUploading ? "Uploading…" : "Drop photos / clips"}
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">{statusMessage}</p>
          </section>

          <section className="rounded-[24px] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Soundtrack</h2>
              <span className="rounded-full bg-[#f7f4ec] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-strong)]">
                {selectedTrack.mood}
              </span>
            </div>
            <div className="mt-3 grid max-h-[240px] gap-1.5 overflow-y-auto pr-1">
              {MUSIC_LIBRARY.map((track) => {
                const active = track.id === selectedTrack.id;
                return (
                  <button
                    className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                      active
                        ? "border-[var(--accent)] bg-[#eef9f7]"
                        : "border-[var(--line)] bg-white/60 hover:border-[var(--accent)]"
                    }`}
                    key={track.id}
                    onClick={() => setSelectedTrack(track)}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{track.name}</span>
                      <span className="text-[10px] text-[var(--muted)]">{track.mood}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-[var(--muted)]">
                      {track.description}
                    </p>
                  </button>
                );
              })}
            </div>
            <audio
              className="mt-3 w-full"
              controls
              key={selectedTrack.id}
              src={selectedTrack.src}
            />
          </section>

          <section className="rounded-[24px] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">AI director</h2>
              <button
                className="rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[var(--accent-strong)] disabled:opacity-50"
                disabled={aiStatus === "running" || timeline.length === 0}
                onClick={() => void runAIAnalysis()}
                type="button"
              >
                {aiStatus === "running" ? "Working…" : "Auto-pick"}
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">{aiMessage}</p>
          </section>
        </aside>
      </section>

      <section className="rounded-[28px] border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]">
        <TimelineRail
          beatPeriodSeconds={beatPeriodSeconds}
          currentFrame={currentFrame}
          fps={FPS}
          onAutoFit={autoFit}
          onCaptionChange={setCaption}
          onRemove={removeItem}
          onReorder={setTimeline}
          onSeek={seekTo}
          onSetTrim={setTrim}
          onTargetSecondsChange={setTargetSeconds}
          perSlotFrames={perSlotFrames}
          targetSeconds={targetSeconds}
          timeline={timeline}
          totalDurationFrames={totalFrames}
          transitionFrames={TRANSITION_FRAMES}
        />
      </section>
    </main>
  );
}
