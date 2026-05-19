import { Composition } from "remotion";
import { SlideshowComposition } from "../components/slideshow-composition";
import type { TimelineMedia } from "../lib/media";
import type { Overlay } from "../lib/overlays";

const FPS = 30;
const FALLBACK_SECONDS_PER_IMAGE = 1;
const MUSIC_LENGTH_SECONDS = 24;
const TRANSITION_FRAMES = 12;

type SlideshowProps = {
  images: TimelineMedia[];
  soundtrackSrc: string;
  soundtrackLoopFrames?: number;
  perSlotFrames?: number[];
  perSlotStartFrames?: number[];
  fallbackSecondsPerImage: number;
  captions?: string[];
  transitionFrames?: number;
  overlays?: Overlay[];
  editingOverlayId?: string | null;
};

export const RemotionRoot = () => {
  return (
    <Composition
      id="Slideshow"
      component={SlideshowComposition}
      durationInFrames={FPS * 5}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{
        images: [],
        soundtrackSrc: "/music/summer-sprint-loop.wav",
        soundtrackLoopFrames: Math.round(MUSIC_LENGTH_SECONDS * FPS),
        fallbackSecondsPerImage: FALLBACK_SECONDS_PER_IMAGE,
        transitionFrames: TRANSITION_FRAMES,
      }}
      calculateMetadata={({ props }) => {
        const slots = props.perSlotFrames;
        if (!slots || slots.length === 0) {
          return { durationInFrames: FPS * 5 };
        }
        let sum = slots.reduce((acc, n) => acc + n, 0);
        const txn = props.transitionFrames ?? TRANSITION_FRAMES;
        for (let i = 0; i < slots.length - 1; i += 1) {
          const overlap = Math.max(
            2,
            Math.min(txn, Math.floor(slots[i] / 2), Math.floor(slots[i + 1] / 2)),
          );
          sum -= overlap;
        }
        return { durationInFrames: Math.max(sum, 1) };
      }}
    />
  );
};
