import {
  AbsoluteFill,
  Img,
  Loop,
  Video,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Html5Audio,
  interpolate,
} from "remotion";
import {
  TransitionSeries,
  linearTiming,
  type TransitionPresentation,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import type { TimelineMedia } from "@/lib/media";

type SlideshowCompositionProps = {
  images: TimelineMedia[];
  soundtrackSrc: string;
  soundtrackLoopFrames?: number;
  perSlotFrames?: number[];
  perSlotStartFrames?: number[];
  fallbackSecondsPerImage: number;
  captions?: string[];
  transitionFrames?: number;
};

const PRESENTATION_CYCLE = ["fade", "slide", "wipe"] as const;
type PresentationName = (typeof PRESENTATION_CYCLE)[number];

function presentationFor(name: PresentationName): TransitionPresentation<Record<string, unknown>> {
  if (name === "slide") return slide() as TransitionPresentation<Record<string, unknown>>;
  if (name === "wipe") return wipe() as TransitionPresentation<Record<string, unknown>>;
  return fade() as TransitionPresentation<Record<string, unknown>>;
}

export function SlideshowComposition({
  images,
  soundtrackSrc,
  soundtrackLoopFrames,
  perSlotFrames,
  perSlotStartFrames,
  fallbackSecondsPerImage,
  captions,
  transitionFrames = 12,
}: SlideshowCompositionProps) {
  const { fps } = useVideoConfig();

  const slots = images.map((item, index) => {
    let frames: number;
    if (perSlotFrames && perSlotFrames[index] != null) {
      frames = Math.max(1, Math.round(perSlotFrames[index]));
    } else if (
      item.kind === "video" &&
      item.durationSeconds &&
      item.durationSeconds > 0
    ) {
      frames = Math.max(1, Math.round(item.durationSeconds * fps));
    } else {
      frames = Math.max(1, Math.round(fallbackSecondsPerImage * fps));
    }
    const startFrom = Math.max(0, Math.round(perSlotStartFrames?.[index] ?? 0));
    return { item, index, frames, startFrom };
  });

  return (
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(180deg, rgba(10, 25, 47, 1) 0%, rgba(18, 52, 86, 1) 100%)",
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: `url(${staticFile("placeholder/film-grain.png")})`,
          backgroundSize: "cover",
          opacity: 0.16,
          mixBlendMode: "screen",
        }}
      />

      <TransitionSeries>
        {slots.map(({ item, index, frames, startFrom }, sequenceIdx) => {
          const elements = [
            <TransitionSeries.Sequence
              key={item.id}
              durationInFrames={frames}
            >
              <SlotContent
                caption={captions?.[index]}
                index={index}
                item={item}
                startFrom={startFrom}
                totalFrames={frames}
              />
            </TransitionSeries.Sequence>,
          ];
          if (sequenceIdx < slots.length - 1) {
            const presentationName =
              PRESENTATION_CYCLE[sequenceIdx % PRESENTATION_CYCLE.length];
            const nextFrames = slots[sequenceIdx + 1].frames;
            const safeOverlap = Math.max(
              2,
              Math.min(
                transitionFrames,
                Math.floor(frames / 2),
                Math.floor(nextFrames / 2),
              ),
            );
            elements.push(
              <TransitionSeries.Transition
                key={`${item.id}-t`}
                presentation={presentationFor(presentationName)}
                timing={linearTiming({ durationInFrames: safeOverlap })}
              />,
            );
          }
          return elements;
        })}
      </TransitionSeries>

      {soundtrackLoopFrames && soundtrackLoopFrames > 0 ? (
        <Loop durationInFrames={soundtrackLoopFrames}>
          <Html5Audio src={soundtrackSrc} volume={0.55} />
        </Loop>
      ) : (
        <Html5Audio src={soundtrackSrc} volume={0.55} />
      )}
    </AbsoluteFill>
  );
}

type SlotContentProps = {
  item: TimelineMedia;
  index: number;
  totalFrames: number;
  startFrom: number;
  caption?: string;
};

function SlotContent({ item, index, totalFrames, startFrom, caption }: SlotContentProps) {
  const frame = useCurrentFrame();
  const isVideo = item.kind === "video";
  const variant = index % 4;

  const scaleStart = isVideo ? 1 : variant === 0 ? 1.0 : variant === 1 ? 1.12 : 1.06;
  const scaleEnd = isVideo ? 1 : variant === 0 ? 1.12 : variant === 1 ? 1.0 : 1.06;
  const xStart = isVideo ? 0 : variant === 2 ? -4 : variant === 3 ? 4 : 0;
  const xEnd = isVideo ? 0 : variant === 2 ? 4 : variant === 3 ? -4 : 0;

  const scale = interpolate(frame, [0, totalFrames], [scaleStart, scaleEnd], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const xPercent = interpolate(frame, [0, totalFrames], [xStart, xEnd], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const transform = `translate(${xPercent}%, 0) scale(${scale})`;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {isVideo ? (
        <Video
          acceptableTimeShiftInSeconds={10}
          muted
          pauseWhenBuffering={false}
          src={item.src}
          {...(startFrom > 0 ? { trimBefore: startFrom } : {})}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform,
          }}
        />
      ) : (
        <Img
          src={item.src}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform,
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(15, 23, 42, 0.08) 0%, rgba(15, 23, 42, 0.36) 100%)",
        }}
      />
      {caption ? (
        <div
          style={{
            position: "absolute",
            left: 72,
            right: 72,
            bottom: 220,
            textAlign: "center",
            color: "white",
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
            fontWeight: 700,
            fontSize: 56,
            lineHeight: 1.15,
            textShadow: "0 4px 32px rgba(0,0,0,0.45)",
          }}
        >
          {caption}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: 52,
          right: 52,
          bottom: 72,
          display: "flex",
          justifyContent: "space-between",
          color: "white",
          fontFamily: "Georgia, serif",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontSize: 24,
        }}
      >
        <span>Montaj</span>
        <span>{String(index + 1).padStart(2, "0")}</span>
      </div>
    </AbsoluteFill>
  );
}
