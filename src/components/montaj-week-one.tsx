"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { SlideshowComposition } from "@/components/slideshow-composition";
import { LIBRARY_DRAG_MIME, TimelineRail } from "@/components/timeline-rail";
import {
  MUSIC_LIBRARY,
  type MusicTrack,
  type TimelineMedia,
  extractVideoThumbnails,
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

type NavSection =
  | "media"
  | "audio"
  | "text"
  | "captions"
  | "effects"
  | "transitions"
  | "filters"
  | "export";

export function MontajWeekOne() {
  const [timeline, setTimeline] = useState<TimelineMedia[]>([]);
  const [library, setLibrary] = useState<TimelineMedia[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<MusicTrack>(MUSIC_LIBRARY[0]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [navSection, setNavSection] = useState<NavSection>("media");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (event: { detail: { frame: number } }) => {
      setCurrentFrame(event.detail.frame);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onEnded);
    };
  }, []);

  const seekTo = useCallback((frame: number) => {
    playerRef.current?.seekTo(Math.max(0, Math.round(frame)));
  }, []);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
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
      const uploaded = await uploadFilesToSupabase(files);
      setLibrary((current) => [...current, ...uploaded]);
      setStatusMessage(
        `${uploaded.length} item${uploaded.length === 1 ? "" : "s"} ready — drag onto the rail to add.`,
      );

      // Generate thumbnails in the background for any uploaded videos.
      // Used only for static UI (library tile poster + rail filmstrip).
      for (const item of uploaded) {
        if (item.kind !== "video" || !item.durationSeconds) continue;
        void extractVideoThumbnails(item.src, item.durationSeconds)
          .then((frames) => {
            if (frames.length === 0) return;
            const apply = (list: TimelineMedia[]) =>
              list.map((it) => (it.id === item.id ? { ...it, previewFrames: frames } : it));
            setLibrary(apply);
            setTimeline(apply);
          })
          .catch(() => {
            // No thumbnail = blank tile; harmless.
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      setStatusMessage(message);
    } finally {
      setIsUploading(false);
    }
  }

  function insertLibraryItem(libraryId: string, atIndex: number) {
    // Don't nest one setter inside another — under strict mode the updater
    // runs twice and the inner setTimeline insert would duplicate.
    const item = library.find((it) => it.id === libraryId);
    if (!item) return;
    setLibrary((current) => current.filter((it) => it.id !== libraryId));
    setTimeline((current) => {
      const clamped = Math.max(0, Math.min(atIndex, current.length));
      const next = [...current];
      next.splice(clamped, 0, item);
      return next;
    });
  }

  function removeLibraryItem(id: string) {
    setLibrary((current) => {
      const removed = current.find((it) => it.id === id);
      if (removed?.src.startsWith("blob:")) URL.revokeObjectURL(removed.src);
      return current.filter((it) => it.id !== id);
    });
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

  const selectedClip =
    selectedClipId == null ? null : timeline.find((it) => it.id === selectedClipId) ?? null;

  return (
    <main className="flex h-screen w-full overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      <LeftNav active={navSection} onChange={setNavSection} />

      <MediaPanel
        aiMessage={aiMessage}
        aiStatus={aiStatus}
        beatGrid={beatGrid}
        beatStatus={beatStatus}
        fileInputRef={fileInputRef}
        isDragging={isDragging}
        isUploading={isUploading}
        library={library}
        onFiles={handleFiles}
        onRemoveLibrary={removeLibraryItem}
        onRunAi={runAIAnalysis}
        onSelectTrack={setSelectedTrack}
        onSetDragging={setIsDragging}
        section={navSection}
        selectedTrack={selectedTrack}
        statusMessage={statusMessage}
        timelineLength={timeline.length}
      />

      <section className="flex min-h-0 flex-1 flex-col gap-3 bg-[var(--bg-soft)] px-3 py-3">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
          <div
            className="overflow-hidden rounded-xl bg-[var(--panel-strong)]"
            style={{ height: "100%", aspectRatio: "9 / 16" }}
          >
            <Player
              acknowledgeRemotionLicense
              clickToPlay
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
              style={{ width: "100%", height: "100%" }}
            />
          </div>
        </div>

        <PlaybackToolbar
          currentFrame={currentFrame}
          fps={FPS}
          isPlaying={isPlaying}
          onTogglePlay={togglePlay}
          totalFrames={totalFrames}
        />

        <section className="shrink-0 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
          <TimelineRail
            beatPeriodSeconds={beatPeriodSeconds}
            currentFrame={currentFrame}
            fps={FPS}
            onAutoFit={autoFit}
            onCaptionChange={setCaption}
            onLibraryDrop={insertLibraryItem}
            onRemove={(id) => {
              if (id === selectedClipId) setSelectedClipId(null);
              removeItem(id);
            }}
            onReorder={setTimeline}
            onSeek={seekTo}
            onSelectClip={setSelectedClipId}
            onSetTrim={setTrim}
            onTargetSecondsChange={setTargetSeconds}
            perSlotFrames={perSlotFrames}
            selectedClipId={selectedClipId}
            targetSeconds={targetSeconds}
            timeline={timeline}
            totalDurationFrames={totalFrames}
            transitionFrames={TRANSITION_FRAMES}
          />
        </section>
      </section>

      <RightPanel
        beatPeriodSeconds={beatPeriodSeconds}
        clip={selectedClip}
        onCaptionChange={setCaption}
        onClose={() => setSelectedClipId(null)}
        onRemove={(id) => {
          setSelectedClipId(null);
          removeItem(id);
        }}
      />
    </main>
  );
}

type PlaybackToolbarProps = {
  currentFrame: number;
  totalFrames: number;
  fps: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
};

function PlaybackToolbar({
  currentFrame,
  totalFrames,
  fps,
  isPlaying,
  onTogglePlay,
}: PlaybackToolbarProps) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-4 py-2">
      <button
        aria-label={isPlaying ? "Pause" : "Play"}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-white transition hover:bg-[var(--accent-strong)]"
        onClick={onTogglePlay}
        type="button"
      >
        {isPlaying ? (
          <svg fill="currentColor" height="16" viewBox="0 0 24 24" width="16">
            <rect height="14" rx="1" width="4" x="6" y="5" />
            <rect height="14" rx="1" width="4" x="14" y="5" />
          </svg>
        ) : (
          <svg fill="currentColor" height="16" viewBox="0 0 24 24" width="16">
            <path d="M8 5v14l11-7L8 5z" />
          </svg>
        )}
      </button>
      <div className="font-mono text-sm text-[var(--ink-soft)]">
        <span className="font-medium">{formatTimecode(currentFrame / fps)}</span>
        <span className="mx-1 text-[var(--muted)]">/</span>
        <span className="text-[var(--muted)]">{formatTimecode(totalFrames / fps)}</span>
      </div>
    </div>
  );
}

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mm = Math.floor(safe / 60);
  const ss = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(cs).padStart(2, "0")}`;
}

type LibraryCardProps = {
  item: TimelineMedia;
  onRemove: (id: string) => void;
};

function LibraryCard({ item, onRemove }: LibraryCardProps) {
  const duration = item.kind === "video" && item.durationSeconds
    ? formatDurationLabel(item.durationSeconds)
    : null;
  const posterSrc = item.kind === "image"
    ? item.src
    : item.previewFrames?.[Math.floor((item.previewFrames.length - 1) / 2)] ?? null;
  return (
    <li
      className="group relative cursor-grab overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] text-xs transition hover:border-[var(--line-strong)] active:cursor-grabbing"
      draggable
      onDragEnd={(e) => {
        e.currentTarget.classList.remove("opacity-50");
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(LIBRARY_DRAG_MIME, item.id);
        e.dataTransfer.setData("text/plain", item.name);
        e.currentTarget.classList.add("opacity-50");
      }}
    >
      <div className="relative aspect-[4/3] w-full bg-[var(--panel-soft)]">
        {posterSrc ? (
          <img alt="" className="h-full w-full object-cover" draggable={false} src={posterSrc} />
        ) : item.kind === "video" ? (
          <div className="flex h-full w-full items-center justify-center text-[11px] font-medium text-[var(--muted)]">
            Loading…
          </div>
        ) : null}
        {duration ? (
          <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 py-0.5 font-mono text-[10px] text-white">
            {duration}
          </span>
        ) : null}
        <button
          aria-label={`Remove ${item.name} from library`}
          className="absolute right-1 top-1 rounded-md bg-black/55 px-1.5 text-[10px] text-white opacity-0 transition hover:bg-rose-500 group-hover:opacity-100"
          onClick={() => onRemove(item.id)}
          type="button"
        >
          ✕
        </button>
      </div>
      <div className="truncate px-2 py-1 text-[10px] text-[var(--ink-soft)]">{item.name}</div>
    </li>
  );
}

function formatDurationLabel(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

const NAV_ITEMS: { id: NavSection; label: string; icon: string }[] = [
  { id: "media", label: "Media", icon: "▦" },
  { id: "audio", label: "Audio", icon: "♪" },
  { id: "text", label: "Text", icon: "T" },
  { id: "captions", label: "Captions", icon: "❝" },
  { id: "effects", label: "Effects", icon: "✶" },
  { id: "transitions", label: "Transitions", icon: "⇆" },
  { id: "filters", label: "Filters", icon: "◐" },
  { id: "export", label: "Export", icon: "↑" },
];

function LeftNav({
  active,
  onChange,
}: {
  active: NavSection;
  onChange: (id: NavSection) => void;
}) {
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-stretch gap-1 border-r border-[var(--line)] bg-[var(--panel)] py-3">
      <div className="mb-2 px-2 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
        Montaj
      </div>
      {NAV_ITEMS.map((it) => {
        const isActive = it.id === active;
        return (
          <button
            aria-label={it.label}
            aria-pressed={isActive}
            className={`mx-2 flex flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-[10px] transition ${
              isActive
                ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                : "text-[var(--muted)] hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]"
            }`}
            key={it.id}
            onClick={() => onChange(it.id)}
            type="button"
          >
            <span className="text-base leading-none">{it.icon}</span>
            <span className="font-medium tracking-wide">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

type MediaPanelProps = {
  aiMessage: string;
  aiStatus: "idle" | "running" | "ok" | "error";
  beatGrid: BeatGrid | null;
  beatStatus: "idle" | "running" | "ok" | "error";
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isDragging: boolean;
  isUploading: boolean;
  library: TimelineMedia[];
  onFiles: (files: FileList | null) => void | Promise<void>;
  onRemoveLibrary: (id: string) => void;
  onRunAi: () => void | Promise<void>;
  onSelectTrack: (t: MusicTrack) => void;
  onSetDragging: (v: boolean) => void;
  section: NavSection;
  selectedTrack: MusicTrack;
  statusMessage: string;
  timelineLength: number;
};

function MediaPanel(props: MediaPanelProps) {
  const {
    aiMessage,
    aiStatus,
    beatGrid,
    beatStatus,
    fileInputRef,
    isDragging,
    isUploading,
    library,
    onFiles,
    onRemoveLibrary,
    onRunAi,
    onSelectTrack,
    onSetDragging,
    section,
    selectedTrack,
    statusMessage,
    timelineLength,
  } = props;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--panel)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-4 py-3">
        <h2 className="text-sm font-medium capitalize text-[var(--ink-soft)]">{section}</h2>
        {section === "media" ? (
          <>
            <button
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-[var(--accent-strong)]"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              + Upload
            </button>
            <input
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif,video/quicktime,video/mp4,.mov,.mp4,.m4v"
              className="sr-only"
              multiple
              onChange={(e) => {
                void onFiles(e.target.files);
                e.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
          </>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {section === "media" ? (
          <>
            <div
              className={`rounded-lg border border-dashed px-3 py-3 text-center text-xs leading-5 transition ${
                isDragging
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                  : "border-[var(--line-strong)] bg-[var(--panel-soft)] text-[var(--muted)]"
              }`}
              onDragLeave={() => onSetDragging(false)}
              onDragOver={(e) => {
                e.preventDefault();
                onSetDragging(true);
              }}
              onDrop={(e) => {
                e.preventDefault();
                onSetDragging(false);
                void onFiles(e.dataTransfer.files);
              }}
            >
              {isUploading ? "Uploading…" : "Drop files here"}
            </div>
            {library.length > 0 ? (
              <ul className="mt-3 grid grid-cols-2 gap-2" data-library-list>
                {library.map((item) => (
                  <LibraryCard
                    item={item}
                    key={item.id}
                    onRemove={onRemoveLibrary}
                  />
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-[11px] leading-4 text-[var(--muted)]">{statusMessage}</p>
          </>
        ) : null}

        {section === "audio" ? (
          <>
            <div className="grid gap-1.5">
              {MUSIC_LIBRARY.map((track) => {
                const active = track.id === selectedTrack.id;
                return (
                  <button
                    className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--panel-soft)] hover:border-[var(--line-strong)]"
                    }`}
                    key={track.id}
                    onClick={() => onSelectTrack(track)}
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
            <p className="mt-3 text-[11px] leading-4 text-[var(--muted)]">
              {beatStatus === "running"
                ? "Detecting BPM…"
                : beatGrid
                  ? `${beatGrid.bpm} BPM detected`
                  : beatStatus === "error"
                    ? "BPM detection failed"
                    : "—"}
            </p>
          </>
        ) : null}

        {section === "captions" ? (
          <div className="grid gap-2">
            <button
              className="rounded-full bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[var(--accent-strong)] disabled:opacity-50"
              disabled={aiStatus === "running" || timelineLength === 0}
              onClick={() => void onRunAi()}
              type="button"
            >
              {aiStatus === "running" ? "Working…" : "Auto-caption with AI"}
            </button>
            <p className="text-[11px] leading-4 text-[var(--muted)]">{aiMessage}</p>
          </div>
        ) : null}

        {section !== "media" && section !== "audio" && section !== "captions" ? (
          <div className="rounded-lg border border-dashed border-[var(--line-strong)] bg-[var(--panel-soft)] p-6 text-center text-xs leading-5 text-[var(--muted)]">
            {section.charAt(0).toUpperCase() + section.slice(1)} coming soon.
          </div>
        ) : null}
      </div>
    </aside>
  );
}

type RightPanelProps = {
  clip: TimelineMedia | null;
  beatPeriodSeconds: number | null;
  onCaptionChange: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
};

function RightPanel({
  clip,
  beatPeriodSeconds,
  onCaptionChange,
  onRemove,
  onClose,
}: RightPanelProps) {
  if (!clip) return null;
  const seconds = clip.beats != null && beatPeriodSeconds
    ? clip.beats * beatPeriodSeconds
    : clip.durationSeconds ?? null;
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--panel)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-4 py-3">
        <h2 className="truncate text-sm font-medium text-[var(--ink-soft)]" title={clip.name}>{clip.name}</h2>
        <button
          aria-label="Close panel"
          className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]"
          onClick={onClose}
          type="button"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-xs">
        <div className="grid gap-1">
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Type</div>
          <div className="font-medium">{clip.kind}</div>
        </div>
        {seconds != null ? (
          <div className="grid gap-1">
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Active length</div>
            <div className="font-medium">{seconds.toFixed(1)}s · {clip.beats ?? "—"} beats</div>
          </div>
        ) : null}
        {clip.kind === "video" && clip.durationSeconds != null ? (
          <div className="grid gap-1">
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Source length</div>
            <div className="font-medium">{clip.durationSeconds.toFixed(1)}s</div>
          </div>
        ) : null}

        <label className="mt-1 grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Caption</span>
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs focus:border-[var(--accent)] focus:outline-none"
            onChange={(e) => onCaptionChange(clip.id, e.target.value)}
            placeholder="Add caption…"
            type="text"
            value={clip.caption ?? ""}
          />
        </label>

        <PlaceholderRow label="Speed" />
        <PlaceholderRow label="Volume" />
        <PlaceholderRow label="Filters" />
        <PlaceholderRow label="Animation" />
        <PlaceholderRow label="Adjust" />

        <button
          className="mt-2 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 hover:text-rose-700"
          onClick={() => onRemove(clip.id)}
          type="button"
        >
          Delete clip
        </button>
      </div>
    </aside>
  );
}

function PlaceholderRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5">
      <span className="font-medium">{label}</span>
      <span className="text-[10px] text-[var(--muted)]">soon</span>
    </div>
  );
}
