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
  deleteAudioAsset,
  extractVideoThumbnails,
  formatBytes,
  getStorageStatus,
  loadProjectAssets,
  loadProjectAudioTracks,
  resolveTimelineMediaUrls,
  uploadAudioFileToSupabase,
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
import {
  createStickerOverlay,
  createTextOverlay,
  EMOJI_PALETTE,
  migrateLoadedOverlay,
  OVERLAY_ANIMATIONS,
  STICKER_PALETTE,
  twemojiUrlFor,
  type Overlay,
  type OverlayAnimation,
} from "@/lib/overlays";
import { OVERLAY_FONTS, type OverlayFontId } from "@/lib/fonts";

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
  | "stickers"
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
  const [customTracks, setCustomTracks] = useState<MusicTrack[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string>(
    MUSIC_LIBRARY[0].id,
  );
  const allTracks = useMemo(
    () => [...MUSIC_LIBRARY, ...customTracks],
    [customTracks],
  );
  const selectedTrack: MusicTrack = useMemo(
    () =>
      allTracks.find((t) => t.id === selectedTrackId) ?? MUSIC_LIBRARY[0],
    [allTracks, selectedTrackId],
  );
  const [audioUploading, setAudioUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [navSection, setNavSection] = useState<NavSection>(
    projectId ? "media" : "dashboard",
  );
  const effectiveNavSection: NavSection = projectId ? navSection : "dashboard";

  // Preview canvas zoom + pan state. "fit" computes to scale 1 with the
  // current aspect-ratio layout (the inner already contains the video within
  // the wrapper). 0.5/1/2 = explicit %.
  type PreviewZoom = "fit" | 0.5 | 1 | 2;
  const [previewZoom, setPreviewZoom] = useState<PreviewZoom>("fit");
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef<{
    startClientX: number;
    startClientY: number;
    initialPanX: number;
    initialPanY: number;
  } | null>(null);
  const effectiveZoom = previewZoom === "fit" ? 1 : previewZoom;
  function setZoomAndRecenter(next: PreviewZoom) {
    setPreviewZoom(next);
    setPreviewPan({ x: 0, y: 0 });
  }

  function startPan(e: React.PointerEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (
      t.closest(
        "[data-overlay-handle], [data-overlay-resize-handle], [data-overlay-editor], [data-preview-zoom]",
      )
    )
      return;
    panRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      initialPanX: previewPan.x,
      initialPanY: previewPan.y,
    };
    setIsPanning(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function movePan(e: React.PointerEvent<HTMLDivElement>) {
    const drag = panRef.current;
    if (!drag) return;
    setPreviewPan({
      x: drag.initialPanX + (e.clientX - drag.startClientX),
      y: drag.initialPanY + (e.clientY - drag.startClientY),
    });
  }
  function endPan(e: React.PointerEvent<HTMLDivElement>) {
    if (!panRef.current) return;
    panRef.current = null;
    setIsPanning(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

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
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  // Serialized snapshot of the last state we know matches the DB (set on load
  // and after each successful autosave). The autosave loop compares against
  // this before writing, so even a falsely-flipped dirtyRef can never clobber
  // the saved doc with a stale/empty in-memory state.
  const lastSavedSnapshotRef = useRef<string | null>(null);
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
  // Tracks which projectId has already had its document loaded + signed URLs
  // resolved. Without this guard, an upstream `supabase` ref change (e.g.
  // Clerk session refresh) would re-fire the load effect mid-playback and
  // remint signed URLs, which remounts <Video> and stalls at readyState=0.
  const loadedProjectRef = useRef<string | null>(null);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    // Throttle frame state updates to ~10 Hz. Remotion's frameupdate fires per
    // browser frame (~60 Hz); calling setState that often re-renders the entire
    // editor (including TimelineRail's tick row + playhead) and starves the
    // Player's own RAF loop, causing playback to drift well under 1x wall time.
    // Precise frame is still available via playerRef.current.getCurrentFrame().
    let lastSetAt = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingFrame = 0;
    const FRAME_UPDATE_MS = 100;
    const flush = () => {
      pendingTimer = null;
      lastSetAt = performance.now();
      setCurrentFrame(pendingFrame);
    };
    const onFrame = (event: { detail: { frame: number } }) => {
      pendingFrame = event.detail.frame;
      const since = performance.now() - lastSetAt;
      if (since >= FRAME_UPDATE_MS) {
        if (pendingTimer != null) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        flush();
      } else if (pendingTimer == null) {
        pendingTimer = setTimeout(flush, FRAME_UPDATE_MS - since);
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      // Flush the precise pause frame so the counter and playhead settle.
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      setCurrentFrame(player.getCurrentFrame());
    };
    const onEnded = () => {
      setIsPlaying(false);
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      setCurrentFrame(player.getCurrentFrame());
    };
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    return () => {
      if (pendingTimer != null) clearTimeout(pendingTimer);
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
    if (loadedProjectRef.current === projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const project = await getProject(supabase, projectId);
        if (cancelled) return;
        let loadedDoc: ProjectDocument = {
          timeline: [],
          selectedTrackId: MUSIC_LIBRARY[0].id,
          targetSeconds: DEFAULT_TARGET_SECONDS,
          overlays: [],
        };
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
          // Just pin the saved id; the derivation picks the actual track from
          // MUSIC_LIBRARY or customTracks once they load.
          setSelectedTrackId(doc.selectedTrackId ?? MUSIC_LIBRARY[0].id);
          setTargetSeconds(doc.targetSeconds ?? DEFAULT_TARGET_SECONDS);
          const migratedOverlays = (doc.overlays ?? []).map(migrateLoadedOverlay);
          setOverlays(migratedOverlays);
          loadedDoc = {
            timeline: resolvedTimeline,
            selectedTrackId: doc.selectedTrackId ?? MUSIC_LIBRARY[0].id,
            targetSeconds: doc.targetSeconds ?? DEFAULT_TARGET_SECONDS,
            overlays: migratedOverlays,
          };
        }
        // Mark loaded for both branches (project with document, and a fresh
        // project that has no document yet) so the effect doesn't re-fire.
        loadedProjectRef.current = projectId;
        // Snapshot the in-memory state we just loaded (post resolve/truncation)
        // as the autosave baseline. If a future autosave tick would write a doc
        // identical to this snapshot, it skips the write — so a truncated load
        // can't clobber the canonical doc on disk with [] or fewer items.
        lastSavedSnapshotRef.current = JSON.stringify(loadedDoc);
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

  // Load user-uploaded audio tracks for this project so they appear in the
  // Audio panel alongside the built-in MUSIC_LIBRARY.
  useEffect(() => {
    if (!supabase || !projectId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCustomTracks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const tracks = await loadProjectAudioTracks(supabase, projectId);
        if (cancelled) return;
        setCustomTracks(tracks);
      } catch (e) {
        if (!cancelled) {
          setStatusMessage(
            `Failed to load audio tracks: ${e instanceof Error ? e.message : "unknown error"}`,
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
  }, [timeline, selectedTrack, targetSeconds, overlays, projectLoaded]);

  // 15s autosave loop. Skips when nothing has changed.
  useEffect(() => {
    if (!supabase || !projectId || !projectLoaded) return;
    const id = setInterval(async () => {
      if (!dirtyRef.current || savingRef.current) return;
      const doc: ProjectDocument = {
        timeline,
        selectedTrackId: selectedTrack.id,
        targetSeconds,
        overlays,
      };
      const snapshot = JSON.stringify(doc);
      // Compare against the last known-on-disk snapshot. If the in-memory
      // state matches what's already saved, skip the write. This stops the
      // "load arrives with truncated timeline → autosave persists the empty
      // result → original doc gone" failure mode.
      if (snapshot === lastSavedSnapshotRef.current) {
        dirtyRef.current = false;
        return;
      }
      savingRef.current = true;
      dirtyRef.current = false;
      setSaveState("saving");
      try {
        await updateProjectDocument(supabase, projectId, doc);
        lastSavedSnapshotRef.current = snapshot;
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
  }, [supabase, projectId, projectLoaded, timeline, selectedTrack, targetSeconds, overlays]);

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

  // Player-composition start frame of each clip on the timeline. Same overlap
  // formula as totalFrames so click-to-seek lands exactly where the player
  // renders clip N's first frame.
  const perSlotPlayerStartFrames = useMemo(() => {
    if (perSlotFrames.length === 0) return [] as number[];
    const starts: number[] = [0];
    let acc = 0;
    for (let i = 0; i < perSlotFrames.length - 1; i += 1) {
      const overlap = Math.max(
        2,
        Math.min(
          TRANSITION_FRAMES,
          Math.floor(perSlotFrames[i] / 2),
          Math.floor(perSlotFrames[i + 1] / 2),
        ),
      );
      acc += perSlotFrames[i] - overlap;
      starts.push(acc);
    }
    return starts;
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
  // Memoize the entire Player inputProps so its identity is stable across
  // unrelated parent re-renders (e.g. frameupdate). A fresh inputProps object
  // on each render propagates into Remotion's playback useEffect deps and
  // resets its `startedTime` accumulator, which causes the player to drift
  // below 1x wall time (the more re-renders/sec, the slower the player).
  const playerInputProps = useMemo(() => ({
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
    soundtrackLoopFrames: Math.round(
      (selectedTrack.durationSeconds ?? MUSIC_LENGTH_SECONDS) * FPS,
    ),
    perSlotFrames: timeline.length > 0 ? perSlotFrames : undefined,
    perSlotStartFrames: timeline.length > 0 ? perSlotStartFrames : undefined,
    fallbackSecondsPerImage: FALLBACK_SECONDS_PER_IMAGE,
    captions: timeline.length > 0 ? captions : undefined,
    transitionFrames: TRANSITION_FRAMES,
    overlays,
    editingOverlayId,
  }), [timeline, selectedTrack.src, selectedTrack.durationSeconds, perSlotFrames, perSlotStartFrames, captions, overlays, editingOverlayId]);
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

  async function handleAudioFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!supabase || !userId || !projectId) {
      setStatusMessage("Open or create a project before uploading audio.");
      return;
    }
    setAudioUploading(true);
    setStatusMessage("Uploading audio…");
    try {
      const uploaded: MusicTrack[] = [];
      for (const file of Array.from(files)) {
        const track = await uploadAudioFileToSupabase(
          { supabase, userId, projectId },
          file,
        );
        uploaded.push(track);
      }
      setCustomTracks((cur) => [...cur, ...uploaded]);
      if (uploaded.length > 0) setSelectedTrackId(uploaded[0].id);
      setStatusMessage(
        `${uploaded.length} track${uploaded.length === 1 ? "" : "s"} uploaded.`,
      );
    } catch (error) {
      setStatusMessage(
        `Audio upload failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      setAudioUploading(false);
    }
  }

  async function removeCustomTrack(track: MusicTrack) {
    if (!supabase || !track.storagePath) return;
    try {
      await deleteAudioAsset(supabase, track.id, track.storagePath);
      setCustomTracks((cur) => cur.filter((t) => t.id !== track.id));
      if (selectedTrackId === track.id) {
        setSelectedTrackId(MUSIC_LIBRARY[0].id);
      }
    } catch (error) {
      setStatusMessage(
        `Could not remove track: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
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

  const reelSeconds = totalFrames > 0 ? totalFrames / FPS : 0;

  function clampOverlayTiming(
    startSeconds: number,
    durationSeconds: number,
  ): { startSeconds: number; durationSeconds: number } {
    // Overlays can extend slightly past the reel end (so users can add one to
    // a not-yet-trimmed timeline) but never go negative. We clamp duration to
    // >= 0.1s to keep the bar pickable.
    const safeStart = Math.max(0, startSeconds);
    const safeDur = Math.max(0.1, durationSeconds);
    return { startSeconds: safeStart, durationSeconds: safeDur };
  }

  function seekToOverlayMid(overlay: Overlay) {
    // Land the playhead in the middle of the overlay's window so the user
    // sees the text/emoji fully visible while editing — past any fade/zoom/
    // slide-up animation that would otherwise show opacity 0 at the boundary.
    const targetSeconds = overlay.startSeconds + overlay.durationSeconds * 0.5;
    seekTo(targetSeconds * FPS);
  }

  function addTextOverlay() {
    const start = currentFrame / FPS;
    const overlay = createTextOverlay("Your text here", start);
    setOverlays((cur) => [...cur, overlay]);
    setSelectedOverlayId(overlay.id);
    setSelectedClipId(null);
    setEditingOverlayId(overlay.id);
    seekToOverlayMid(overlay);
  }

  function addStickerOverlay(glyph: string) {
    const start = currentFrame / FPS;
    const overlay = createStickerOverlay(glyph, start);
    setOverlays((cur) => [...cur, overlay]);
    setSelectedOverlayId(overlay.id);
    setSelectedClipId(null);
    seekToOverlayMid(overlay);
  }

  function beginEditingOverlay(id: string) {
    const overlay = overlays.find((o) => o.id === id);
    if (!overlay || overlay.kind !== "text") return;
    setSelectedOverlayId(id);
    setSelectedClipId(null);
    setEditingOverlayId(id);
    seekToOverlayMid(overlay);
  }

  function updateOverlay(id: string, patch: Partial<Overlay>) {
    setOverlays((cur) =>
      cur.map((o) => {
        if (o.id !== id) return o;
        const next = { ...o, ...patch };
        if (patch.startSeconds != null || patch.durationSeconds != null) {
          const clamped = clampOverlayTiming(
            next.startSeconds,
            next.durationSeconds,
          );
          next.startSeconds = clamped.startSeconds;
          next.durationSeconds = clamped.durationSeconds;
        }
        return next;
      }),
    );
  }

  function removeOverlay(id: string) {
    setOverlays((cur) => cur.filter((o) => o.id !== id));
    if (selectedOverlayId === id) setSelectedOverlayId(null);
  }

  // Delete/Backspace removes the currently selected overlay or clip. Skipped
  // when focus is inside a typing surface so users can still backspace inside
  // text fields, the inline preview editor, the right-panel inputs, etc.
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null): boolean {
      const node = el as (HTMLElement & { isContentEditable?: boolean }) | null;
      if (!node) return false;
      if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") return true;
      if (node.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isTypingTarget(e.target)) return;
      if (editingOverlayId != null) return;
      if (selectedOverlayId != null) {
        e.preventDefault();
        removeOverlay(selectedOverlayId);
        return;
      }
      if (selectedClipId != null) {
        e.preventDefault();
        const id = selectedClipId;
        setSelectedClipId(null);
        removeItem(id);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // removeOverlay / removeItem are stable enough — they only close over
    // setState setters; re-binding when ids change is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOverlayId, selectedClipId, editingOverlayId]);

  const selectedOverlay = useMemo(
    () => overlays.find((o) => o.id === selectedOverlayId) ?? null,
    [overlays, selectedOverlayId],
  );

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

  // Clicking anywhere outside the right panel dismisses it. Clip/overlay
  // clicks already stopPropagation in the rail, so picking another item still
  // works. The inline text editor inside the preview also stops propagation
  // so typing doesn't trigger this.
  const handleMainClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (
        selectedClipId == null &&
        selectedOverlayId == null &&
        editingOverlayId == null
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-right-panel]")) return;
      if (target.closest("[data-overlay-drag-layer]")) return;
      setSelectedClipId(null);
      setSelectedOverlayId(null);
      setEditingOverlayId(null);
    },
    [selectedClipId, selectedOverlayId, editingOverlayId],
  );

  return (
    <main
      className="relative flex h-screen w-full flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)] sm:flex-row"
      onClick={handleMainClick}
    >
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
          audioUploading={audioUploading}
          customTracks={customTracks}
          onAddSticker={addStickerOverlay}
          onAddText={addTextOverlay}
          onAudioFiles={handleAudioFiles}
          onFiles={handleFiles}
          onRemoveCustomTrack={removeCustomTrack}
          onRemoveLibrary={removeLibraryItem}
          onRunAi={runAIAnalysis}
          onSelectTrack={(t) => setSelectedTrackId(t.id)}
          onSetDragging={setIsDragging}
          section={navSection}
          selectedTrack={selectedTrack}
          statusMessage={statusMessage}
          timelineLength={timeline.length}
        />
      )}

      {/* Right panel: strict flex column with vertical overflow handling.
          When the viewport is shorter than (preview min + toolbar + timeline),
          the wrapper scrolls instead of pushing the timeline off-screen. */}
      <section className="flex w-full min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-[var(--bg-soft)] px-3 py-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--line-strong)] [&::-webkit-scrollbar]:w-2">
        {/* Video preview — flex-grow:1 with a tight min so the timeline below
            always fits. Acts as a bounded viewport (overflow-hidden) for an
            inner zoom/pan-able canvas. Cursor reflects grab/grabbing state. */}
        <div
          className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-2 ${
            isPanning ? "cursor-grabbing" : "cursor-grab"
          }`}
          onPointerCancel={endPan}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
        >
          <div
            className="relative h-full max-w-full overflow-hidden rounded-xl bg-[var(--panel-strong)]"
            style={{
              aspectRatio: "9 / 16",
              transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${effectiveZoom})`,
              transformOrigin: "center center",
              transition: isPanning ? "none" : "transform 0.15s ease-out",
            }}
          >
            <Player
              acknowledgeRemotionLicense
              clickToPlay
              component={SlideshowComposition}
              compositionWidth={1080}
              compositionHeight={1920}
              durationInFrames={durationInFrames}
              fps={FPS}
              inputProps={playerInputProps}
              ref={playerRef}
              style={{ width: "100%", height: "100%" }}
            />
            <OverlayDragLayer
              currentFrame={currentFrame}
              editingOverlayId={editingOverlayId}
              fps={FPS}
              onBeginEdit={beginEditingOverlay}
              onChange={updateOverlay}
              onEndEdit={() => setEditingOverlayId(null)}
              onSelect={(id) => {
                setSelectedOverlayId(id);
                if (id != null) setSelectedClipId(null);
                if (id !== editingOverlayId) setEditingOverlayId(null);
                if (id != null) {
                  const o = overlays.find((ov) => ov.id === id);
                  if (o) seekToOverlayMid(o);
                }
              }}
              overlays={overlays}
              selectedOverlayId={selectedOverlayId}
            />
          </div>

          {/* Zoom dropdown — bottom-right of the preview viewport. Pointer
              events are stopped so clicking the dropdown doesn't start a pan. */}
          <div
            className="absolute bottom-3 right-3 z-20 flex items-center gap-2"
            data-preview-zoom
            onPointerDown={(e) => e.stopPropagation()}
          >
            <select
              aria-label="Preview zoom"
              className="cursor-pointer rounded-md border border-[var(--line)] bg-[var(--panel)]/95 px-2 py-1 text-xs font-medium text-[var(--ink-soft)] shadow-sm backdrop-blur transition hover:border-[var(--accent)]"
              onChange={(e) => {
                const v = e.target.value;
                setZoomAndRecenter(
                  v === "fit" ? "fit" : (Number(v) as PreviewZoom),
                );
              }}
              value={previewZoom === "fit" ? "fit" : String(previewZoom)}
            >
              <option value="fit">Fit</option>
              <option value="0.5">50%</option>
              <option value="1">100%</option>
              <option value="2">200%</option>
            </select>
          </div>
        </div>

        <PlaybackToolbar
          currentFrame={currentFrame}
          fps={FPS}
          isPlaying={isPlaying}
          onTogglePlay={togglePlay}
          totalFrames={totalFrames}
        />

        {/* Timeline — shrink-0 + min-h-[350px] keeps it anchored at the bottom
            and never compressed when the viewport shrinks. */}
        <section className="min-h-[350px] shrink-0 overflow-auto rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-2">
          <TimelineRail
            beatPeriodSeconds={beatPeriodSeconds}
            currentFrame={currentFrame}
            fps={FPS}
            onAutoFit={autoFit}
            onCaptionChange={setCaption}
            onLibraryDrop={insertLibraryItem}
            onOverlayTimingChange={(id, startSeconds, durationSeconds) =>
              updateOverlay(id, { startSeconds, durationSeconds })
            }
            onRemove={(id) => {
              if (id === selectedClipId) setSelectedClipId(null);
              removeItem(id);
            }}
            onReorder={setTimeline}
            onSeek={seekTo}
            onSelectClip={(id) => {
              setSelectedClipId(id);
              if (id != null) {
                setSelectedOverlayId(null);
                const idx = timeline.findIndex((it) => it.id === id);
                if (idx >= 0) {
                  seekTo(perSlotPlayerStartFrames[idx] ?? 0);
                }
              }
            }}
            onSelectOverlay={(id) => {
              setSelectedOverlayId(id);
              if (id != null) {
                setSelectedClipId(null);
                const o = overlays.find((ov) => ov.id === id);
                if (o) seekToOverlayMid(o);
              }
            }}
            onSetTrim={setTrim}
            onTargetSecondsChange={setTargetSeconds}
            overlays={overlays}
            perSlotFrames={perSlotFrames}
            selectedClipId={selectedClipId}
            selectedOverlayId={selectedOverlayId}
            targetSeconds={targetSeconds}
            timeline={timeline}
            totalDurationFrames={totalFrames}
            transitionFrames={TRANSITION_FRAMES}
          />
        </section>
      </section>

      {selectedOverlay ? (
        <OverlayRightPanel
          onChange={(patch) => updateOverlay(selectedOverlay.id, patch)}
          onClose={() => setSelectedOverlayId(null)}
          onRemove={() => removeOverlay(selectedOverlay.id)}
          overlay={selectedOverlay}
        />
      ) : (
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
      )}
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

type OverlayDragLayerProps = {
  overlays: Overlay[];
  selectedOverlayId: string | null;
  editingOverlayId: string | null;
  currentFrame: number;
  fps: number;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Overlay>) => void;
  onBeginEdit: (id: string) => void;
  onEndEdit: () => void;
};

type DragMode =
  | "move"
  | "resize-nw"
  | "resize-n"
  | "resize-ne"
  | "resize-w"
  | "resize-e"
  | "resize-sw"
  | "resize-s"
  | "resize-se";

type HandlePos = Exclude<DragMode, "move"> extends `resize-${infer P}`
  ? P
  : never;

const HANDLE_POSITIONS: HandlePos[] = [
  "nw",
  "n",
  "ne",
  "w",
  "e",
  "sw",
  "s",
  "se",
];

function signsForMode(mode: DragMode): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  switch (mode) {
    case "resize-nw": return { x: -1, y: -1 };
    case "resize-n":  return { x: 0,  y: -1 };
    case "resize-ne": return { x: 1,  y: -1 };
    case "resize-w":  return { x: -1, y: 0 };
    case "resize-e":  return { x: 1,  y: 0 };
    case "resize-sw": return { x: -1, y: 1 };
    case "resize-s":  return { x: 0,  y: 1 };
    case "resize-se": return { x: 1,  y: 1 };
    default:          return { x: 0,  y: 0 };
  }
}

function OverlayDragLayer({
  overlays,
  selectedOverlayId,
  editingOverlayId,
  currentFrame,
  fps,
  onSelect,
  onChange,
  onBeginEdit,
  onEndEdit,
}: OverlayDragLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    kind: Overlay["kind"];
    mode: DragMode;
    pointerStartX: number;
    pointerStartY: number;
    initialX: number;
    initialY: number;
    initialWidth: number;
    initialFontSize: number;
    rectW: number;
    rectH: number;
  } | null>(null);

  const seconds = currentFrame / fps;
  const visible = overlays.filter(
    (o) => seconds >= o.startSeconds && seconds < o.startSeconds + o.durationSeconds,
  );

  const effectiveEditingId =
    editingOverlayId && visible.some((o) => o.id === editingOverlayId)
      ? editingOverlayId
      : null;

  if (visible.length === 0) return null;

  const beginDrag = (
    overlay: Overlay,
    mode: DragMode,
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    e.stopPropagation();
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      id: overlay.id,
      kind: overlay.kind,
      mode,
      pointerStartX: e.clientX,
      pointerStartY: e.clientY,
      initialX: overlay.x,
      initialY: overlay.y,
      initialWidth: overlay.widthFraction ?? 0.7,
      initialFontSize: overlay.fontSize,
      rectW: rect.width,
      rectH: rect.height,
    };
    onSelect(overlay.id);
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxFraction = (e.clientX - drag.pointerStartX) / drag.rectW;
    const dyFraction = (e.clientY - drag.pointerStartY) / drag.rectH;

    if (drag.mode === "move") {
      onChange(drag.id, {
        x: Math.max(0, Math.min(1, drag.initialX + dxFraction)),
        y: Math.max(0, Math.min(1, drag.initialY + dyFraction)),
      });
      return;
    }

    // Word-style resize: horizontal handles change widthFraction (text wrap);
    // vertical handles change fontSize (text height). Corner handles do both.
    // Width keeps the opposite edge anchored (re-centers x by half the delta);
    // fontSize keeps the center y fixed — text grows symmetrically about its
    // anchor point.
    const { x: signX, y: signY } = signsForMode(drag.mode);
    const patch: Partial<Overlay> = {};
    if (signX !== 0) {
      const nextWidth = Math.max(
        0.08,
        Math.min(1, drag.initialWidth + signX * dxFraction),
      );
      const widthDelta = nextWidth - drag.initialWidth;
      patch.widthFraction = nextWidth;
      patch.x = Math.max(
        0,
        Math.min(1, drag.initialX + (signX * widthDelta) / 2),
      );
    }
    if (signY !== 0) {
      // Composition height is 1920 px; dyFraction is fraction of rect height.
      // So fontSize delta in composition px = signY × dyFraction × 1920. Cap
      // matches the right-panel Size slider (240 text / 360 sticker) so the
      // slider always reflects what dragging produced.
      const fontDelta = signY * dyFraction * 1920;
      const maxFont = drag.kind === "text" ? 240 : 360;
      const nextFont = Math.max(
        24,
        Math.min(maxFont, drag.initialFontSize + fontDelta),
      );
      patch.fontSize = nextFont;
    }
    onChange(drag.id, patch);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      data-overlay-drag-layer
      ref={layerRef}
      style={{ containerType: "size" }}
    >
      {visible.map((overlay) => {
        const isSelected = selectedOverlayId === overlay.id;
        const isEditing =
          overlay.kind === "text" && effectiveEditingId === overlay.id;
        if (isEditing) {
          return (
            <InlineTextEditor
              key={overlay.id}
              onChange={(value) => onChange(overlay.id, { content: value })}
              onExit={onEndEdit}
              overlay={overlay}
            />
          );
        }
        return (
          <OverlayBoxHandle
            isSelected={isSelected}
            key={overlay.id}
            onBeginDrag={(mode, e) => beginDrag(overlay, mode, e)}
            onDoubleClick={() => {
              if (overlay.kind !== "text") return;
              onBeginEdit(overlay.id);
            }}
            onPointerMove={handleMove}
            onPointerUp={endDrag}
            overlay={overlay}
          />
        );
      })}
    </div>
  );
}

function OverlayBoxHandle({
  overlay,
  isSelected,
  onBeginDrag,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
}: {
  overlay: Overlay;
  isSelected: boolean;
  onBeginDrag: (mode: DragMode, e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}) {
  const widthFraction = overlay.widthFraction ?? 0.7;
  const isText = overlay.kind === "text";
  // Snap the click target close to the rendered text size. Composition height
  // is 1920 px, so a fontSize-px line height maps to (fontSize × 1.15 / 1920)
  // × 100 of the drag layer's height. Single-line estimate — multi-line text
  // is undersized but still clickable per line.
  const heightCqh = (overlay.fontSize * 1.15) / 1920 * 100;
  return (
    <div
      className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 transition ${
        isSelected ? "border-[var(--accent)]" : "border-transparent"
      }`}
      data-overlay-handle
      data-overlay-id={overlay.id}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      onPointerDown={(e) => onBeginDrag("move", e)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        left: `${overlay.x * 100}%`,
        top: `${overlay.y * 100}%`,
        width: `${widthFraction * 100}%`,
        height: `${heightCqh}cqh`,
        minHeight: 24,
        cursor: "move",
      }}
      title={
        isText
          ? "Drag to move · double-click to edit · drag handles to resize"
          : "Drag to move · drag handles to resize"
      }
    >
      {isSelected
        ? HANDLE_POSITIONS.map((pos) => (
            <ResizeHandle key={pos} onBeginDrag={onBeginDrag} position={pos} />
          ))
        : null}
    </div>
  );
}

const HANDLE_LAYOUT: Record<
  HandlePos,
  { style: React.CSSProperties; cursor: string }
> = {
  nw: { style: { left: -6, top: -6 }, cursor: "nwse-resize" },
  n:  { style: { left: "50%", top: -6, transform: "translateX(-50%)" }, cursor: "ns-resize" },
  ne: { style: { right: -6, top: -6 }, cursor: "nesw-resize" },
  w:  { style: { left: -6, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
  e:  { style: { right: -6, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
  sw: { style: { left: -6, bottom: -6 }, cursor: "nesw-resize" },
  s:  { style: { left: "50%", bottom: -6, transform: "translateX(-50%)" }, cursor: "ns-resize" },
  se: { style: { right: -6, bottom: -6 }, cursor: "nwse-resize" },
};

function ResizeHandle({
  position,
  onBeginDrag,
}: {
  position: HandlePos;
  onBeginDrag: (mode: DragMode, e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const { style, cursor } = HANDLE_LAYOUT[position];
  return (
    <div
      aria-hidden
      className="absolute h-3 w-3 rounded-sm border border-white bg-[var(--accent)]"
      data-overlay-resize-handle
      data-position={position}
      onPointerDown={(e) => {
        e.stopPropagation();
        onBeginDrag(`resize-${position}`, e);
      }}
      style={{ ...style, cursor }}
    />
  );
}

function InlineTextEditor({
  overlay,
  onChange,
  onExit,
}: {
  overlay: Overlay;
  onChange: (value: string) => void;
  onExit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // `cqw` = 1% of the parent container's width. Composition is 1080px wide,
  // so an overlay fontSize of N px corresponds to (N / 1080 * 100) cqw in
  // the drag layer (which always matches the player aspect-ratio).
  const fontSizeCqw = (overlay.fontSize / 1080) * 100;
  const widthFraction = overlay.widthFraction ?? 0.7;
  return (
    <textarea
      className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 resize-none border-2 border-[var(--accent)] bg-transparent text-center outline-none"
      data-overlay-editor
      data-overlay-id={overlay.id}
      onBlur={onExit}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onExit();
        }
        // Stop space/arrow from reaching the Player (which would play/seek).
        e.stopPropagation();
      }}
      ref={ref}
      rows={2}
      style={{
        left: `${overlay.x * 100}%`,
        top: `${overlay.y * 100}%`,
        fontFamily: fontFamilyForOverlay(overlay),
        fontWeight: 700,
        color: overlay.color ?? "#ffffff",
        fontSize: `${fontSizeCqw}cqw`,
        lineHeight: 1.15,
        textShadow: "0 4px 32px rgba(0,0,0,0.55)",
        width: `${widthFraction * 100}%`,
        caretColor: "var(--accent)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        padding: 0,
      }}
      value={overlay.content}
    />
  );
}

function fontFamilyForOverlay(overlay: Overlay): string {
  const id = overlay.fontFamily ?? "inter";
  return OVERLAY_FONTS.find((f) => f.id === id)?.cssFamily ?? OVERLAY_FONTS[0].cssFamily;
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
  { id: "stickers", label: "Stickers", icon: "☆" },
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
    <nav className="flex w-full shrink-0 flex-row items-center gap-1 overflow-x-auto border-b border-[var(--line)] bg-[var(--panel)] px-2 py-2 sm:w-[72px] sm:flex-col sm:items-stretch sm:overflow-visible sm:border-b-0 sm:border-r sm:px-0 sm:py-3">
      <div className="mx-2 shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)] sm:mb-2 sm:mx-0 sm:px-2 sm:text-center">
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
            className={`flex shrink-0 flex-col items-center gap-1 rounded-lg px-2 py-1.5 transition sm:mx-1.5 sm:px-1 sm:py-2 ${
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
  audioUploading: boolean;
  beatGrid: BeatGrid | null;
  beatStatus: "idle" | "running" | "ok" | "error";
  customTracks: MusicTrack[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isDragging: boolean;
  isUploading: boolean;
  library: TimelineMedia[];
  onAddText: () => void;
  onAddSticker: (glyph: string) => void;
  onAudioFiles: (files: FileList | null) => void | Promise<void>;
  onFiles: (files: FileList | null) => void | Promise<void>;
  onRemoveCustomTrack: (track: MusicTrack) => void | Promise<void>;
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
    audioUploading,
    beatGrid,
    beatStatus,
    customTracks,
    fileInputRef,
    isDragging,
    isUploading,
    library,
    onAddText,
    onAddSticker,
    onAudioFiles,
    onFiles,
    onRemoveCustomTrack,
    onRemoveLibrary,
    onRunAi,
    onSelectTrack,
    onSetDragging,
    section,
    selectedTrack,
    statusMessage,
    timelineLength,
  } = props;
  const audioInputRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-[var(--line)] bg-[var(--panel)] sm:max-h-none max-h-[40vh] sm:w-[300px] sm:border-b-0 sm:border-r">
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
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
                Your tracks
              </span>
              <button
                className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-[var(--accent-strong)] disabled:opacity-50"
                disabled={audioUploading}
                onClick={() => audioInputRef.current?.click()}
                type="button"
              >
                {audioUploading ? "Uploading…" : "+ Upload"}
              </button>
            </div>
            <input
              accept="audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/aac,audio/ogg,audio/flac,audio/webm,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm"
              className="sr-only"
              multiple
              onChange={(e) => {
                void onAudioFiles(e.target.files);
                e.target.value = "";
              }}
              ref={audioInputRef}
              type="file"
            />
            {customTracks.length > 0 ? (
              <div className="mb-3 grid gap-1.5">
                {customTracks.map((track) => {
                  const active = track.id === selectedTrack.id;
                  return (
                    <div
                      className={`group flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition ${
                        active
                          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                          : "border-[var(--line)] bg-[var(--panel-soft)] hover:border-[var(--line-strong)]"
                      }`}
                      key={track.id}
                    >
                      <button
                        className="flex-1 text-left"
                        onClick={() => onSelectTrack(track)}
                        type="button"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-semibold" title={track.name}>
                            {track.name}
                          </span>
                          <span className="shrink-0 text-[10px] text-[var(--muted)]">
                            {track.durationLabel}
                          </span>
                        </div>
                      </button>
                      <button
                        aria-label={`Remove ${track.name}`}
                        className="rounded p-1 text-[var(--muted)] opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                        onClick={() => void onRemoveCustomTrack(track)}
                        type="button"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mb-3 text-[11px] leading-4 text-[var(--muted)]">
                Upload mp3, wav, m4a, aac, ogg, or flac. They&apos;re scoped to
                this project.
              </p>
            )}

            <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Built-in
            </div>
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

        {section === "text" ? <TextPanelContent onAddText={onAddText} /> : null}

        {section === "stickers" ? (
          <StickerPanelContent onAddSticker={onAddSticker} />
        ) : null}

        {section !== "media" &&
        section !== "audio" &&
        section !== "captions" &&
        section !== "text" &&
        section !== "stickers" ? (
          <div className="rounded-lg border border-dashed border-[var(--line-strong)] bg-[var(--panel-soft)] p-6 text-center text-xs leading-5 text-[var(--muted)]">
            {section.charAt(0).toUpperCase() + section.slice(1)} coming soon.
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function TextPanelContent({ onAddText }: { onAddText: () => void }) {
  return (
    <div className="grid gap-3">
      <button
        className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[var(--accent-strong)]"
        onClick={onAddText}
        type="button"
      >
        + Add text
      </button>
      <p className="text-[11px] leading-4 text-[var(--muted)]">
        Text is added at the playhead for 2s. Drag the bar on the timeline to
        change start and duration, edit content in the right panel, or
        double-click in the preview to edit inline. Use the emoji picker in
        the right panel to insert emoji into the text.
      </p>
    </div>
  );
}

function StickerPanelContent({
  onAddSticker,
}: {
  onAddSticker: (glyph: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-[11px] leading-4 text-[var(--muted)]">
        Tap a sticker to drop it at the playhead. Drag in the preview to
        reposition, or grab any handle to resize — like a WhatsApp sticker.
      </p>
      <div className="grid grid-cols-3 gap-2" data-sticker-palette>
        {STICKER_PALETTE.map((glyph) => (
          <button
            aria-label={`Add ${glyph} sticker`}
            className="group flex aspect-square items-center justify-center rounded-2xl border border-[var(--line)] bg-[var(--panel-soft)] p-2 transition hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:shadow-md"
            key={glyph}
            onClick={() => onAddSticker(glyph)}
            type="button"
          >
            <img
              alt={`${glyph} sticker`}
              className="h-full w-full transition group-hover:scale-105"
              draggable={false}
              src={twemojiUrlFor(glyph)}
              style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.2))" }}
            />
          </button>
        ))}
      </div>
    </div>
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
    <aside
      data-right-panel
      className="flex w-full shrink-0 flex-col border-t border-[var(--line)] bg-[var(--panel)] sm:max-h-none max-h-[50vh] sm:w-[300px] sm:border-l sm:border-t-0"
    >
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
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 text-xs [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--line-strong)] [&::-webkit-scrollbar]:w-2">
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

type OverlayRightPanelProps = {
  overlay: Overlay;
  onChange: (patch: Partial<Overlay>) => void;
  onRemove: () => void;
  onClose: () => void;
};

function OverlayRightPanel({
  overlay,
  onChange,
  onRemove,
  onClose,
}: OverlayRightPanelProps) {
  const isText = overlay.kind === "text";
  const endSeconds = overlay.startSeconds + overlay.durationSeconds;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Selection state lags React renders — remember it as a ref so an emoji
  // click after blur still inserts at the right spot.
  const lastSelectionRef = useRef<{ start: number; end: number } | null>(null);
  function rememberSelection() {
    const ta = textareaRef.current;
    if (!ta) return;
    lastSelectionRef.current = {
      start: ta.selectionStart ?? ta.value.length,
      end: ta.selectionEnd ?? ta.value.length,
    };
  }
  function insertEmoji(glyph: string) {
    const sel = lastSelectionRef.current ?? {
      start: overlay.content.length,
      end: overlay.content.length,
    };
    const before = overlay.content.slice(0, sel.start);
    const after = overlay.content.slice(sel.end);
    const next = before + glyph + after;
    const cursor = sel.start + glyph.length;
    onChange({ content: next });
    lastSelectionRef.current = { start: cursor, end: cursor };
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    });
  }
  return (
    <aside
      data-right-panel
      className="flex w-full shrink-0 flex-col border-t border-[var(--line)] bg-[var(--panel)] sm:max-h-none max-h-[50vh] sm:w-[300px] sm:border-l sm:border-t-0"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-4 py-3">
        <h2 className="truncate text-sm font-medium text-[var(--ink-soft)]">
          {isText ? "Text overlay" : "Sticker overlay"}
        </h2>
        <button
          aria-label="Close panel"
          className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]"
          onClick={onClose}
          type="button"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 text-xs [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--line-strong)] [&::-webkit-scrollbar]:w-2">
        <div className="grid gap-1">
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Type</div>
          <div className="font-medium">{overlay.kind}</div>
        </div>

        <div className="grid gap-1">
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Active window
          </div>
          <div className="font-medium">
            {overlay.startSeconds.toFixed(1)}s → {endSeconds.toFixed(1)}s
            <span className="ml-1 text-[var(--muted)]">
              ({overlay.durationSeconds.toFixed(1)}s)
            </span>
          </div>
        </div>

        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            {isText ? "Text" : "Sticker"}
          </span>
          {isText ? (
            <textarea
              className="min-h-[64px] rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs focus:border-[var(--accent)] focus:outline-none"
              onBlur={rememberSelection}
              onClick={rememberSelection}
              onChange={(e) => onChange({ content: e.target.value })}
              onKeyUp={rememberSelection}
              onSelect={rememberSelection}
              placeholder="Your text here"
              ref={textareaRef}
              value={overlay.content}
            />
          ) : (
            <div className="flex items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
              <img
                alt={`${overlay.content} sticker`}
                className="h-16 w-16"
                draggable={false}
                src={twemojiUrlFor(overlay.content)}
                style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.2))" }}
              />
            </div>
          )}
        </label>

        {!isText ? (
          <div className="grid gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Swap sticker
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {EMOJI_PALETTE.map((glyph) => {
                const active = glyph === overlay.content;
                return (
                  <button
                    aria-label={`Swap to ${glyph}`}
                    aria-pressed={active}
                    className={`flex aspect-square items-center justify-center rounded-lg border p-1 transition ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--panel-soft)] hover:border-[var(--accent)]"
                    }`}
                    key={glyph}
                    onClick={() => onChange({ content: glyph })}
                    type="button"
                  >
                    <img
                      alt=""
                      className="h-full w-full"
                      draggable={false}
                      src={twemojiUrlFor(glyph)}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {isText ? (
          <div className="grid gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Emoji
            </span>
            <div className="grid grid-cols-8 gap-1" data-emoji-picker>
              {EMOJI_PALETTE.map((glyph) => (
                <button
                  aria-label={`Insert ${glyph}`}
                  className="flex h-7 items-center justify-center rounded border border-[var(--line)] bg-[var(--panel-soft)] text-base transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  key={glyph}
                  onClick={() => insertEmoji(glyph)}
                  type="button"
                >
                  {glyph}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--muted)]">
              Inserts at cursor (or end of text).
            </p>
          </div>
        ) : null}

        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Start (s)
          </span>
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs focus:border-[var(--accent)] focus:outline-none"
            min={0}
            onChange={(e) => onChange({ startSeconds: Number(e.target.value) })}
            step={0.1}
            type="number"
            value={overlay.startSeconds.toFixed(2)}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Duration (s)
          </span>
          <input
            className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs focus:border-[var(--accent)] focus:outline-none"
            min={0.1}
            onChange={(e) =>
              onChange({ durationSeconds: Number(e.target.value) })
            }
            step={0.1}
            type="number"
            value={overlay.durationSeconds.toFixed(2)}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Size
          </span>
          <input
            className="w-full"
            max={isText ? 240 : 360}
            min={24}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            step={4}
            type="range"
            value={overlay.fontSize}
          />
          <span className="text-[10px] text-[var(--muted)]">{overlay.fontSize}px</span>
        </label>

        {isText ? (
          <label className="grid gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Color
            </span>
            <input
              className="h-8 w-full cursor-pointer rounded-md border border-[var(--line)] bg-[var(--panel-soft)]"
              onChange={(e) => onChange({ color: e.target.value })}
              type="color"
              value={overlay.color ?? "#ffffff"}
            />
          </label>
        ) : null}

        {isText ? (
          <div className="grid gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Font
            </span>
            <div className="grid grid-cols-2 gap-1.5">
              {OVERLAY_FONTS.map((f) => {
                const active = (overlay.fontFamily ?? "inter") === f.id;
                return (
                  <button
                    aria-pressed={active}
                    className={`flex items-center justify-center rounded-md border px-2 py-2 text-[13px] leading-tight transition ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                        : "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--ink)] hover:border-[var(--line-strong)]"
                    }`}
                    key={f.id}
                    onClick={() => onChange({ fontFamily: f.id })}
                    style={{ fontFamily: f.cssFamily }}
                    title={f.name}
                    type="button"
                  >
                    {f.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Animation
          </span>
          <select
            className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs focus:border-[var(--accent)] focus:outline-none"
            onChange={(e) =>
              onChange({ animation: e.target.value as OverlayAnimation })
            }
            value={overlay.animation ?? "fade"}
          >
            {OVERLAY_ANIMATIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        <p className="text-[10px] leading-4 text-[var(--muted)]">
          Drag the handle in the preview to reposition.
        </p>

        <button
          className="mt-2 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 hover:text-rose-700"
          onClick={onRemove}
          type="button"
        >
          Delete overlay
        </button>
      </div>
    </aside>
  );
}
