"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Player, type PlayerRef } from "@remotion/player";
import { UserButton, useUser } from "@clerk/nextjs";
import { SlideshowComposition } from "@/components/slideshow-composition";
import { LIBRARY_DRAG_MIME, TimelineRail } from "@/components/timeline-rail";
import {
  MUSIC_LIBRARY,
  type MusicTrack,
  type TimelineMedia,
  backfillVideoThumbnails,
  extractVideoThumbnails,
  formatBytes,
  getStorageStatus,
  loadProjectAssets,
  resolveTimelineMediaUrls,
  uploadFilesToSupabase,
} from "@/lib/media";
import { useSupabaseClient } from "@/lib/supabase-browser";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
  updateProjectDocument,
  type ProjectDocument,
  type ProjectSummary,
} from "@/lib/projects";
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
  | "dashboard"
  | "media"
  | "audio"
  | "text"
  | "captions"
  | "effects"
  | "transitions"
  | "filters"
  | "export";

type MontajWeekOneProps = {
  projectId: string | null;
};

const AUTOSAVE_INTERVAL_MS = 15_000;

export function MontajWeekOne({ projectId }: MontajWeekOneProps) {
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user } = useUser();
  const userId = user?.id ?? null;
  const [timeline, setTimeline] = useState<TimelineMedia[]>([]);
  const [library, setLibrary] = useState<TimelineMedia[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<MusicTrack>(MUSIC_LIBRARY[0]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [navSection, setNavSection] = useState<NavSection>(
    projectId ? "media" : "dashboard",
  );
  const effectiveNavSection: NavSection = projectId ? navSection : "dashboard";

  const handleNavSelect = useCallback(
    (id: NavSection) => {
      if (id === "dashboard") {
        if (projectId) router.push("/");
        return;
      }
      if (!projectId) return;
      setNavSection(id);
    },
    [projectId, router],
  );
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const [statusMessage, setStatusMessage] = useState<string>(
    getStorageStatus(supabase).configured
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

  // Load project document once Supabase client + projectId are ready.
  useEffect(() => {
    if (!supabase || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const project = await getProject(supabase, projectId);
        if (cancelled) return;
        if (project?.document) {
          const doc = project.document;
          const resolvedTimeline = await resolveTimelineMediaUrls(
            supabase,
            doc.timeline ?? [],
          );
          if (cancelled) return;
          setTimeline(resolvedTimeline);
          backfillVideoThumbnails(resolvedTimeline, (id, frames) => {
            setTimeline((cur) =>
              cur.map((it) => (it.id === id ? { ...it, previewFrames: frames } : it)),
            );
          });
          const track =
            MUSIC_LIBRARY.find((t) => t.id === doc.selectedTrackId) ??
            MUSIC_LIBRARY[0];
          setSelectedTrack(track);
          setTargetSeconds(doc.targetSeconds ?? DEFAULT_TARGET_SECONDS);
        }
        setProjectLoaded(true);
        dirtyRef.current = false;
      } catch (e) {
        if (!cancelled) {
          setStatusMessage(
            `Failed to load project: ${e instanceof Error ? e.message : "unknown error"}`,
          );
          setProjectLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, projectId]);

  // Load uploaded assets into the media library when a project opens.
  useEffect(() => {
    if (!supabase || !projectId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLibrary([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const items = await loadProjectAssets(supabase, projectId);
        if (cancelled) return;
        setLibrary(items);
        backfillVideoThumbnails(items, (id, frames) => {
          setLibrary((cur) =>
            cur.map((it) => (it.id === id ? { ...it, previewFrames: frames } : it)),
          );
        });
      } catch (e) {
        if (!cancelled) {
          setStatusMessage(
            `Failed to load assets: ${e instanceof Error ? e.message : "unknown error"}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, projectId]);

  // Mark dirty whenever the document state changes (after first load).
  useEffect(() => {
    if (!projectLoaded) return;
    dirtyRef.current = true;
  }, [timeline, selectedTrack, targetSeconds, projectLoaded]);

  // 15s autosave loop. Skips when nothing has changed.
  useEffect(() => {
    if (!supabase || !projectId || !projectLoaded) return;
    const id = setInterval(async () => {
      if (!dirtyRef.current || savingRef.current) return;
      savingRef.current = true;
      dirtyRef.current = false;
      setSaveState("saving");
      try {
        const doc: ProjectDocument = {
          timeline,
          selectedTrackId: selectedTrack.id,
          targetSeconds,
        };
        await updateProjectDocument(supabase, projectId, doc);
        setSaveState("saved");
        setLastSavedAt(Date.now());
      } catch (e) {
        dirtyRef.current = true;
        setSaveState("error");
        setStatusMessage(
          `Autosave failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      } finally {
        savingRef.current = false;
      }
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [supabase, projectId, projectLoaded, timeline, selectedTrack, targetSeconds]);

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
      const uploaded = await uploadFilesToSupabase(
        { supabase, userId, projectId },
        files,
      );
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
    const item = library.find((it) => it.id === libraryId);
    if (!item) return;
    const clone: TimelineMedia = { ...item, id: crypto.randomUUID() };
    setTimeline((current) => {
      const clamped = Math.max(0, Math.min(atIndex, current.length));
      const next = [...current];
      next.splice(clamped, 0, clone);
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
    <main className="relative flex h-screen w-full overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      <div className="pointer-events-auto absolute right-3 top-3 z-50 flex items-center gap-3">
        <span
          className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
            saveState === "saving"
              ? "border-[var(--line)] bg-[var(--panel)] text-[var(--ink-soft)]"
              : saveState === "error"
                ? "border-rose-300 bg-rose-50 text-rose-700"
                : saveState === "saved"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-transparent text-transparent"
          }`}
          aria-live="polite"
        >
          {saveState === "saving"
            ? "Saving…"
            : saveState === "error"
              ? "Save failed"
              : saveState === "saved" && lastSavedAt
                ? `Saved ${new Date(lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "·"}
        </span>
        <UserButton />
      </div>
      <LeftNav
        active={effectiveNavSection}
        onChange={handleNavSelect}
        hasProject={Boolean(projectId)}
      />

      {effectiveNavSection === "dashboard" ? (
        <DashboardPanel currentProjectId={projectId} />
      ) : (
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
      )}

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
  { id: "dashboard", label: "Dashboard", icon: "⌂" },
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
  hasProject,
}: {
  active: NavSection;
  onChange: (id: NavSection) => void;
  hasProject: boolean;
}) {
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-stretch gap-1 border-r border-[var(--line)] bg-[var(--panel)] py-3">
      <div className="mb-2 px-2 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
        Montaj
      </div>
      {NAV_ITEMS.map((it) => {
        const isActive = it.id === active;
        const isDashboard = it.id === "dashboard";
        const disabled = !isDashboard && !hasProject;
        return (
          <button
            aria-label={it.label}
            aria-pressed={isActive}
            disabled={disabled}
            title={it.label}
            className={`mx-1.5 flex flex-col items-center gap-1 rounded-lg px-1 py-2 transition ${
              isActive
                ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                : disabled
                  ? "cursor-not-allowed text-[var(--muted)] opacity-40"
                  : "text-[var(--muted)] hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]"
            }`}
            key={it.id}
            onClick={() => onChange(it.id)}
            type="button"
          >
            <span className="text-base leading-none">{it.icon}</span>
            <span className="w-full truncate text-center text-[9px] font-medium leading-none">
              {it.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function DashboardPanel({
  currentProjectId,
}: {
  currentProjectId: string | null;
}) {
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user, isLoaded } = useUser();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      const rows = await listProjects(supabase);
      setProjects(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (!isLoaded || !user || !supabase) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [isLoaded, user, supabase, refresh]);

  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  async function commitRename(id: string) {
    if (!supabase) return;
    const name = renameDraft.trim();
    const existing = projects.find((p) => p.id === id);
    if (!name || !existing || name === existing.name) {
      setRenamingId(null);
      return;
    }
    try {
      await renameProject(supabase, id, name);
      setProjects((cur) => cur.map((p) => (p.id === id ? { ...p, name } : p)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename project");
    } finally {
      setRenamingId(null);
    }
  }

  async function submitCreate() {
    if (!supabase || !user) return;
    const name = newName.trim();
    if (!name) return;
    setSubmitting(true);
    try {
      const project = await createProject(supabase, user.id, name);
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project");
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!supabase) return;
    if (!confirm("Delete this project? Assets will be removed too.")) return;
    try {
      await deleteProject(supabase, id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
    }
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-[var(--line)] bg-[var(--panel)] px-4 py-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-[var(--ink)]">
          Projects
        </h2>
        {!naming && (
          <button
            type="button"
            onClick={() => {
              setNewName("");
              setNaming(true);
            }}
            className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition hover:bg-[var(--accent-strong)]"
          >
            + New
          </button>
        )}
      </header>

      {naming && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitCreate();
          }}
          className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setNaming(false);
                setNewName("");
              }
            }}
            disabled={submitting}
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setNaming(false);
                setNewName("");
              }}
              disabled={submitting}
              className="rounded-md px-2.5 py-1 text-[11px] text-[var(--ink-soft)] hover:text-[var(--ink)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !newName.trim()}
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition hover:bg-[var(--accent-strong)] disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-[var(--ink-soft)]">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--line)] px-3 py-6 text-center text-xs text-[var(--ink-soft)]">
          No projects yet. Click <strong>+ New</strong> to start.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {projects.map((p) => {
            const isCurrent = currentProjectId === p.id;
            const isRenaming = renamingId === p.id;
            return (
              <li key={p.id} className="group relative">
                {isRenaming ? (
                  <div
                    className={`rounded-lg border px-3 py-2 ${
                      isCurrent
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--panel)]"
                    }`}
                  >
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitRename(p.id);
                        } else if (e.key === "Escape") {
                          setRenamingId(null);
                        }
                      }}
                      className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                    />
                    <div className="mt-0.5 text-[10px] text-[var(--ink-soft)]">
                      {new Date(p.updated_at).toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => router.push(`/projects/${p.id}`)}
                    className={`block w-full rounded-lg border px-3 py-2 text-left transition ${
                      isCurrent
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--panel)] hover:border-[var(--accent)]"
                    }`}
                  >
                    <div className="truncate pr-12 text-sm font-medium text-[var(--ink)]">
                      {p.name}
                    </div>
                    <div className="mt-0.5 text-[10px] text-[var(--ink-soft)]">
                      {new Date(p.updated_at).toLocaleString()}
                    </div>
                  </button>
                )}
                {!isRenaming && (
                  <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => {
                        setRenameDraft(p.name);
                        setRenamingId(p.id);
                      }}
                      aria-label="Rename project"
                      className="rounded p-1 text-[var(--ink-soft)] hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]"
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id)}
                      aria-label="Delete project"
                      className="rounded p-1 text-rose-500 hover:bg-rose-50"
                      title="Delete"
                    >
                      ×
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
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
