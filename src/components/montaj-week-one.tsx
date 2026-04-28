"use client";

import { useMemo, useState } from "react";
import { Player } from "@remotion/player";
import { SlideshowComposition } from "@/components/slideshow-composition";
import {
  MUSIC_LIBRARY,
  type MusicTrack,
  formatBytes,
  getStorageStatus,
  toTimelineMedia,
  uploadFilesToSupabase,
} from "@/lib/media";

const FPS = 30;
const SECONDS_PER_IMAGE = 1;

export function MontajWeekOne() {
  const [timeline, setTimeline] = useState<ReturnType<typeof toTimelineMedia>>([]);
  const [selectedTrack, setSelectedTrack] = useState<MusicTrack>(MUSIC_LIBRARY[0]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>(
    getStorageStatus().configured
      ? "Supabase storage is configured. Uploaded images will also be persisted."
      : "Supabase storage is not configured yet. Images will stay local in the browser for the Week 1 demo.",
  );

  const durationInFrames = Math.max(
    timeline.length * FPS * SECONDS_PER_IMAGE,
    FPS * 5,
  );

  const totalSize = useMemo(
    () => timeline.reduce((sum, item) => sum + item.size, 0),
    [timeline],
  );

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }

    setIsUploading(true);
    setStatusMessage("Preparing your upload...");

    try {
      const nextTimeline = await uploadFilesToSupabase(files);
      setTimeline((current) => [...current, ...nextTimeline]);

      if (getStorageStatus().configured) {
        setStatusMessage(
          `Added ${nextTimeline.length} image${nextTimeline.length === 1 ? "" : "s"} and synced them to Supabase Storage.`,
        );
      } else {
        setStatusMessage(
          `Added ${nextTimeline.length} image${nextTimeline.length === 1 ? "" : "s"} locally. Add Supabase env vars when you want persistence.`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Upload failed.";
      setStatusMessage(message);
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-8 md:px-8">
      <section className="grid gap-4 rounded-[32px] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)] backdrop-blur md:grid-cols-[1.25fr_0.75fr]">
        <div className="space-y-4">
          <p className="text-sm uppercase tracking-[0.3em] text-[var(--accent)]">
            Montaj / Week 1
          </p>
          <h1 className="max-w-3xl text-4xl leading-tight md:text-6xl">
            Upload trip photos, pick a soundtrack, and preview a reel draft.
          </h1>
          <p className="max-w-2xl text-base leading-7 text-[var(--muted)] md:text-lg">
            This prototype covers the Week 1 milestone: project scaffold,
            photo upload, a small built-in music library, and a basic Remotion
            preview with fixed timing.
          </p>
        </div>

        <div className="grid gap-3 rounded-[24px] border border-[var(--line)] bg-white/70 p-5">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--accent-strong)]">
            Checklist
          </p>
          <div className="flex items-center justify-between rounded-2xl bg-[#f7f4ec] px-4 py-3">
            <span>Next.js scaffold</span>
            <span className="font-semibold text-[var(--accent-strong)]">Done</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl bg-[#f7f4ec] px-4 py-3">
            <span>Photo upload flow</span>
            <span className="font-semibold text-[var(--accent-strong)]">Done</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl bg-[#f7f4ec] px-4 py-3">
            <span>Built-in soundtrack picker</span>
            <span className="font-semibold text-[var(--accent-strong)]">Done</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl bg-[#f7f4ec] px-4 py-3">
            <span>Basic Remotion preview</span>
            <span className="font-semibold text-[var(--accent-strong)]">Done</span>
          </div>
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="grid gap-6">
          <section className="rounded-[28px] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl">Upload photos</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  Drag in JPG, PNG, or WebP images. Each photo gets one second on
                  the Week 1 timeline.
                </p>
              </div>
              <label className="cursor-pointer rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong)]">
                Choose files
                <input
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  multiple
                  type="file"
                  onChange={(event) => void handleFiles(event.target.files)}
                />
              </label>
            </div>

            <div
              className={`mt-5 rounded-[24px] border-2 border-dashed px-6 py-10 text-center transition ${
                isDragging
                  ? "border-[var(--accent)] bg-[#eef9f7]"
                  : "border-[var(--line)] bg-white/60"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                void handleFiles(event.dataTransfer.files);
              }}
            >
              <p className="text-lg">Drop travel photos here</p>
              <p className="mt-2 text-sm text-[var(--muted)]">
                {isUploading
                  ? "Uploading..."
                  : "Or use the file picker above."}
              </p>
            </div>

            <p className="mt-4 rounded-2xl bg-[#f7f4ec] px-4 py-3 text-sm leading-6 text-[var(--muted)]">
              {statusMessage}
            </p>
          </section>

          <section className="rounded-[28px] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl">Soundtrack</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  A small built-in library for the demo. These tracks are simple,
                  royalty-free generated loops stored in `public/music`.
                </p>
              </div>
              <span className="rounded-full bg-[#f7f4ec] px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-strong)]">
                {selectedTrack.mood}
              </span>
            </div>

            <div className="mt-5 grid gap-3">
              {MUSIC_LIBRARY.map((track) => {
                const active = track.id === selectedTrack.id;

                return (
                  <button
                    key={track.id}
                    className={`rounded-[22px] border px-4 py-4 text-left transition ${
                      active
                        ? "border-[var(--accent)] bg-[#eef9f7]"
                        : "border-[var(--line)] bg-white/60 hover:border-[var(--accent)]"
                    }`}
                    type="button"
                    onClick={() => setSelectedTrack(track)}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-lg">{track.name}</p>
                        <p className="mt-1 text-sm text-[var(--muted)]">
                          {track.description}
                        </p>
                      </div>
                      <span className="text-sm text-[var(--muted)]">
                        {track.durationLabel}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <audio
              key={selectedTrack.id}
              className="mt-5 w-full"
              controls
              src={selectedTrack.src}
            />
          </section>

        </div>

        <section className="rounded-[28px] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl">Preview</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                Fixed-timing slideshow in Remotion. Each image appears for one
                second and plays alongside the selected track.
              </p>
            </div>
            <div className="rounded-[24px] bg-[#f7f4ec] px-4 py-3 text-sm leading-6 text-[var(--muted)]">
              <p>{timeline.length} images</p>
              <p>{formatBytes(totalSize)}</p>
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-[24px] border border-[var(--line)] bg-[#1e293b]">
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
                        },
                      ],
                soundtrackSrc: selectedTrack.src,
                secondsPerImage: SECONDS_PER_IMAGE,
              }}
              style={{ width: "100%", aspectRatio: "9 / 16" }}
            />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {timeline.length > 0 ? (
              timeline.map((item, index) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-[22px] border border-[var(--line)] bg-white/60 p-3"
                >
                  <img
                    alt={item.name}
                    className="h-16 w-16 rounded-2xl object-cover"
                    src={item.src}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm">{item.name}</p>
                    <p className="text-xs text-[var(--muted)]">
                      Slot {index + 1} · {formatBytes(item.size)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-[22px] border border-[var(--line)] bg-white/60 p-4 text-sm leading-6 text-[var(--muted)] sm:col-span-2">
                Add a few travel photos to replace the placeholder postcard and
                make the preview feel real.
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
