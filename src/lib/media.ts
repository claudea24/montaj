import { createClient } from "@supabase/supabase-js";

export type TimelineMedia = {
  id: string;
  name: string;
  size: number;
  src: string;
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
    id: "coastline",
    name: "Coastline Loop",
    mood: "Bright",
    durationLabel: "0:24",
    description: "Light pulses for sunny arrival shots and beach panoramas.",
    src: "/music/coastline-loop.wav",
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
    id: "postcard",
    name: "Postcard Loop",
    mood: "Warm",
    durationLabel: "0:24",
    description: "Soft chimes and a gentle bass pulse for recap-style reels.",
    src: "/music/postcard-loop.wav",
  },
];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_BUCKET =
  process.env.NEXT_PUBLIC_SUPABASE_BUCKET ?? "montaj-media";

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

export function getStorageStatus() {
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

export function toTimelineMedia(files: FileList | File[]) {
  return Array.from(files).map((file) => ({
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    src: URL.createObjectURL(file),
  }));
}

export async function uploadFilesToSupabase(files: FileList | File[]) {
  return uploadFileArrayToSupabase(Array.from(files));
}

export async function uploadFileArrayToSupabase(files: File[]) {
  const timeline = toTimelineMedia(files);

  if (!supabase) {
    return timeline;
  }

  await Promise.all(
    Array.from(files).map(async (file) => {
      const key = `${Date.now()}-${crypto.randomUUID()}-${file.name}`;
      const { error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(key, file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (error) {
        throw new Error(`Supabase upload failed: ${error.message}`);
      }
    }),
  );

  return timeline;
}
