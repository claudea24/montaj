import type { SupabaseClient } from "@supabase/supabase-js";
import { heicTo, isHeic } from "heic-to";

export type TimelineMediaKind = "image" | "video";

export type TimelineMedia = {
  id: string;
  name: string;
  size: number;
  src: string;
  kind: TimelineMediaKind;
  durationSeconds?: number;
  caption?: string;
  scene?: string;
  qualityScore?: number;
  beats?: number;
  videoStartBeats?: number;
  /** Storage object key in the `montaj-media` bucket once uploaded.
   *  Used to rebuild signed URLs after reload; absent for unsaved local items. */
  storagePath?: string;
  /** Row id in `public.assets`; absent until persisted. */
  assetId?: string;
  /** Sparse JPEG thumbnails for static UI (library tile poster + rail filmstrip).
   *  NOT used during playback — the slot renders the real <Video> directly. */
  previewFrames?: string[];
};

export type MusicTrack = {
  id: string;
  name: string;
  mood: string;
  durationLabel: string;
  description: string;
  src: string;
};

export const MUSIC_LIBRARY: MusicTrack[] = [
  {
    id: "summer-sprint",
    name: "Summer Sprint",
    mood: "Energetic",
    durationLabel: "0:24",
    description: "Punchy 128 BPM kick for action montages and quick cuts.",
    src: "/music/summer-sprint-loop.wav",
  },
  {
    id: "open-road",
    name: "Open Road",
    mood: "Adventure",
    durationLabel: "0:24",
    description: "Driving 112 BPM mid-tempo for trip recaps and travel arcs.",
    src: "/music/open-road-loop.wav",
  },
  {
    id: "coastline",
    name: "Coastline Loop",
    mood: "Bright",
    durationLabel: "0:24",
    description: "Light pulses for sunny arrival shots and beach panoramas.",
    src: "/music/coastline-loop.wav",
  },
  {
    id: "festival-glow",
    name: "Festival Glow",
    mood: "Chill",
    durationLabel: "0:24",
    description: "Smooth 100 BPM groove for golden-hour and food cuts.",
    src: "/music/festival-glow-loop.wav",
  },
  {
    id: "postcard",
    name: "Postcard Loop",
    mood: "Warm",
    durationLabel: "0:24",
    description: "Soft chimes and a gentle bass pulse for recap-style reels.",
    src: "/music/postcard-loop.wav",
  },
  {
    id: "night-drive",
    name: "Night Drive Loop",
    mood: "Moody",
    durationLabel: "0:24",
    description: "A darker synthetic loop for city lights and evening transitions.",
    src: "/music/night-drive-loop.wav",
  },
  {
    id: "deep-cove",
    name: "Deep Cove",
    mood: "Cinematic",
    durationLabel: "0:24",
    description: "Slow 92 BPM pad for sunsets and contemplative shots.",
    src: "/music/deep-cove-loop.wav",
  },
];

const SUPABASE_BUCKET =
  process.env.NEXT_PUBLIC_SUPABASE_BUCKET?.trim() ?? "montaj-media";

export function getStorageStatus(supabase: SupabaseClient | null) {
  return {
    configured: Boolean(supabase),
    bucket: SUPABASE_BUCKET,
  };
}

export function formatBytes(bytes: number) {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const order = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** order;

  return `${value.toFixed(value >= 10 || order === 0 ? 0 : 1)} ${units[order]}`;
}

function isHeicFile(file: File) {
  if (file.type === "image/heic" || file.type === "image/heif") {
    return true;
  }
  return /\.(heic|heif)$/i.test(file.name);
}

function isVideoFile(file: File) {
  if (file.type.startsWith("video/")) {
    return true;
  }
  return /\.(mov|mp4|m4v|webm)$/i.test(file.name);
}

/** Posts the file to the server transcode route. The server returns 204 when
 *  the input is already a clean MP4 (passthrough), an `x-transcoded: remux`
 *  body when it just rewrote the container, or an `x-transcoded: reencode`
 *  body when it had to fully re-encode (HEVC, VFR, etc.). */
async function normalizeUploadedVideo(file: File): Promise<File> {
  const form = new FormData();
  form.append("video", file);
  let res: Response;
  try {
    res = await fetch("/api/transcode-video", { method: "POST", body: form });
  } catch {
    return file;
  }
  if (res.status === 204 || !res.ok) {
    return file;
  }
  const buffer = await res.arrayBuffer();
  const baseName = file.name.replace(/\.(mov|m4v|hevc)$/i, "") || "clip";
  return new File([buffer], `${baseName}.mp4`, { type: "video/mp4" });
}

async function probeVideoDuration(blobUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = blobUrl;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      resolve(duration);
    };
    video.onerror = () => resolve(0);
  });
}

const THUMBNAIL_COUNT = 12;
const THUMBNAIL_MAX_DIMENSION = 240;

function waitForEvent(
  target: EventTarget,
  successEvent: string,
  errorEvent: string,
) {
  return new Promise<void>((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`media event failed: ${successEvent}`));
    };
    const cleanup = () => {
      target.removeEventListener(successEvent, onSuccess);
      target.removeEventListener(errorEvent, onError);
    };
    target.addEventListener(successEvent, onSuccess, { once: true });
    target.addEventListener(errorEvent, onError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, t: number) {
  if (Math.abs(video.currentTime - t) < 0.001) return;
  const done = waitForEvent(video, "seeked", "error");
  video.currentTime = t;
  await done;
}

/** Fire-and-forget thumbnail extraction for any video items that don't yet
 *  have previewFrames. Calls `apply` per-item when frames are ready. Used on
 *  project/library reload because previewFrames aren't persisted to the DB. */
export function backfillVideoThumbnails(
  items: TimelineMedia[],
  apply: (id: string, frames: string[]) => void,
) {
  for (const item of items) {
    if (item.kind !== "video") continue;
    if (item.previewFrames && item.previewFrames.length > 0) continue;
    if (!item.src) continue;
    void extractVideoThumbnails(item.src, item.durationSeconds ?? 0)
      .then((frames) => {
        if (frames.length === 0) return;
        apply(item.id, frames);
      })
      .catch(() => {
        // No thumbnail = "Loading…" tile; harmless.
      });
  }
}

/** Pulls a small set of evenly-spaced JPEG thumbnails. Used only for static UI
 *  decoration (library tiles, rail filmstrip) — never on the playback path. */
export async function extractVideoThumbnails(
  src: string,
  durationSeconds: number,
): Promise<string[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Opt into CORS mode so we can read pixels off cross-origin Supabase signed
  // URLs without tainting the canvas. Local blob: URLs ignore this attribute.
  // Must be set BEFORE assigning src.
  video.crossOrigin = "anonymous";
  video.src = src;
  try {
    await waitForEvent(video, "loadedmetadata", "error");
    const dur = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : durationSeconds;
    if (!Number.isFinite(dur) || dur <= 0) return [];
    const w = video.videoWidth || THUMBNAIL_MAX_DIMENSION;
    const h = video.videoHeight || THUMBNAIL_MAX_DIMENSION;
    const longest = Math.max(w, h);
    const scale = longest > 0 ? Math.min(1, THUMBNAIL_MAX_DIMENSION / longest) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round((w * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((h * scale) / 2) * 2);
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    const frames: string[] = [];
    for (let i = 0; i < THUMBNAIL_COUNT; i += 1) {
      const t = Math.min(dur - 0.001, (i / Math.max(1, THUMBNAIL_COUNT - 1)) * dur);
      await seekVideo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.6));
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

type PreparedMedia = {
  timeline: TimelineMedia;
  uploadFile: File;
};

async function prepareFile(file: File): Promise<PreparedMedia> {
  if (await isHeic(file).catch(() => isHeicFile(file))) {
    const converted = await heicTo({
      blob: file,
      type: "image/jpeg",
      quality: 0.9,
    });
    const jpegName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
    const jpegFile = new File([converted], jpegName, {
      type: "image/jpeg",
    });
    return {
      uploadFile: jpegFile,
      timeline: {
        id: crypto.randomUUID(),
        name: jpegName,
        size: jpegFile.size,
        src: URL.createObjectURL(jpegFile),
        kind: "image",
      },
    };
  }

  if (isVideoFile(file)) {
    const playable = await normalizeUploadedVideo(file);
    const src = URL.createObjectURL(playable);
    const durationSeconds = await probeVideoDuration(src);
    return {
      uploadFile: playable,
      timeline: {
        id: crypto.randomUUID(),
        name: playable.name,
        size: playable.size,
        src,
        kind: "video",
        durationSeconds,
      },
    };
  }

  return {
    uploadFile: file,
    timeline: {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      src: URL.createObjectURL(file),
      kind: "image",
    },
  };
}

type UploadContext = {
  supabase: SupabaseClient | null;
  userId: string | null;
  projectId: string | null;
};

const ASSET_URL_TTL_SECONDS = 60 * 60 * 24;

export async function loadProjectAssets(
  supabase: SupabaseClient,
  projectId: string,
): Promise<TimelineMedia[]> {
  const { data: rows, error } = await supabase
    .from("assets")
    .select(
      "id, kind, name, size_bytes, storage_path, duration_seconds, created_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`loadProjectAssets: ${error.message}`);
  if (!rows || rows.length === 0) return [];

  const paths = rows.map((r) => r.storage_path as string);
  const { data: signed, error: signError } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrls(paths, ASSET_URL_TTL_SECONDS);
  if (signError) throw new Error(`signed URLs: ${signError.message}`);

  const urlByPath = new Map<string, string>();
  for (const s of signed ?? []) {
    if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
  }

  return rows.map((r) => ({
    id: r.id as string,
    assetId: r.id as string,
    name: r.name as string,
    size: Number(r.size_bytes ?? 0),
    src: urlByPath.get(r.storage_path as string) ?? "",
    kind: r.kind as TimelineMediaKind,
    durationSeconds: r.duration_seconds ?? undefined,
    storagePath: r.storage_path as string,
  }));
}

/** Replaces stale src (e.g., blob: URLs from a prior session) with fresh signed
 *  URLs resolved from each item's storagePath. Items without storagePath are
 *  kept as-is if their src is still a usable URL; blob: URLs without backing
 *  storage are dropped because they will only crash Remotion's <Video>. */
export async function resolveTimelineMediaUrls(
  supabase: SupabaseClient,
  items: TimelineMedia[],
): Promise<TimelineMedia[]> {
  const paths = Array.from(
    new Set(
      items
        .map((i) => i.storagePath)
        .filter((p): p is string => Boolean(p)),
    ),
  );
  let urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrls(paths, ASSET_URL_TTL_SECONDS);
    if (error) throw new Error(`resolveTimelineMediaUrls: ${error.message}`);
    urlByPath = new Map(
      (data ?? [])
        .filter((s) => s.path && s.signedUrl)
        .map((s) => [s.path as string, s.signedUrl as string]),
    );
  }
  const resolved: TimelineMedia[] = [];
  for (const it of items) {
    if (it.storagePath) {
      const url = urlByPath.get(it.storagePath);
      if (url) {
        resolved.push({ ...it, src: url });
        continue;
      }
    }
    if (it.src && !it.src.startsWith("blob:")) {
      resolved.push(it);
    }
    // else: stale blob URL with no backing storage — drop it.
  }
  return resolved;
}

export async function uploadFilesToSupabase(
  ctx: UploadContext,
  files: FileList | File[],
) {
  const fileArray = Array.from(files);
  const prepared = await Promise.all(fileArray.map(prepareFile));
  const timeline = prepared.map((p) => p.timeline);
  const { supabase, userId, projectId } = ctx;

  if (!supabase || !userId || !projectId) {
    return timeline;
  }

  await Promise.all(
    prepared.map(async ({ uploadFile }, i) => {
      const safeName = uploadFile.name.replace(/[^A-Za-z0-9._-]/g, "_");
      const key = `${userId}/${projectId}/${crypto.randomUUID()}-${safeName}`;
      const item = timeline[i];

      const { error: uploadError } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(key, uploadFile, { cacheControl: "3600", upsert: false });
      if (uploadError) {
        throw new Error(`Supabase upload failed: ${uploadError.message}`);
      }

      const { data: asset, error: insertError } = await supabase
        .from("assets")
        .insert({
          user_id: userId,
          project_id: projectId,
          kind: item.kind,
          name: uploadFile.name,
          size_bytes: uploadFile.size,
          storage_path: key,
          duration_seconds: item.durationSeconds ?? null,
        })
        .select("id")
        .single();
      if (insertError) {
        throw new Error(`Assets insert failed: ${insertError.message}`);
      }

      item.storagePath = key;
      item.assetId = asset?.id;
    }),
  );

  return timeline;
}
