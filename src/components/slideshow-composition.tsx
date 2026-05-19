import {
  AbsoluteFill,
  Img,
  Loop,
  OffthreadVideo,
  Sequence,
  Video,
  getRemotionEnvironment,
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
import { flip } from "@remotion/transitions/flip";
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { none } from "@remotion/transitions/none";
import type { TimelineMedia } from "@/lib/media";
import type { Overlay } from "@/lib/overlays";
import { twemojiUrlFor } from "@/lib/overlays";
import { fontFamilyFor } from "@/lib/fonts";

type SlideshowCompositionProps = {
  images: TimelineMedia[];
  soundtrackSrc: string;
  soundtrackLoopFrames?: number;
  perSlotFrames?: number[];
  perSlotStartFrames?: number[];
  fallbackSecondsPerImage: number;
  captions?: string[];
  transitionFrames?: number;
  transitionStyle?: TransitionStyle;
  overlays?: Overlay[];
  // When set, the matching overlay renders fully transparent so the inline
  // editor in the drag layer above the player is the only visible copy.
  editingOverlayId?: string | null;
};

export const TRANSITION_STYLES = [
  "cycle",
  "fade",
  "slide",
  "wipe",
  "flip",
  "clock-wipe",
  "none",
] as const;
export type TransitionStyle = (typeof TRANSITION_STYLES)[number];
const CYCLE_ORDER = ["fade", "slide", "wipe"] as const;

function presentationFor(
  style: TransitionStyle,
  sequenceIdx: number,
): TransitionPresentation<Record<string, unknown>> {
  const resolved =
    style === "cycle" ? CYCLE_ORDER[sequenceIdx % CYCLE_ORDER.length] : style;
  if (resolved === "slide") return slide() as TransitionPresentation<Record<string, unknown>>;
  if (resolved === "wipe") return wipe() as TransitionPresentation<Record<string, unknown>>;
  if (resolved === "flip") return flip() as TransitionPresentation<Record<string, unknown>>;
  if (resolved === "clock-wipe")
    return clockWipe({ width: 1080, height: 1920 }) as unknown as TransitionPresentation<Record<string, unknown>>;
  if (resolved === "none") return none() as TransitionPresentation<Record<string, unknown>>;
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
  transitionStyle = "cycle",
  overlays,
  editingOverlayId,
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
                presentation={presentationFor(transitionStyle, sequenceIdx)}
                timing={linearTiming({ durationInFrames: safeOverlap })}
              />,
            );
          }
          return elements;
        })}
      </TransitionSeries>

      {overlays && overlays.length > 0
        ? overlays.map((overlay) => {
            const from = Math.max(0, Math.round(overlay.startSeconds * fps));
            const dur = Math.max(1, Math.round(overlay.durationSeconds * fps));
            const isEditing = editingOverlayId === overlay.id;
            return (
              <Sequence
                key={overlay.id}
                durationInFrames={dur}
                from={from}
                layout="none"
              >
                <OverlayRender
                  hidden={isEditing}
                  overlay={overlay}
                  totalFrames={dur}
                />
              </Sequence>
            );
          })
        : null}

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

function OverlayRender({
  overlay,
  totalFrames,
  hidden,
}: {
  overlay: Overlay;
  totalFrames: number;
  hidden?: boolean;
}) {
  const isText = overlay.kind === "text";
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const animation = overlay.animation ?? "fade";

  // In/out windows clamp to ~0.3s each, but never more than 40% of the
  // overlay's total duration so very short overlays still appear.
  const animFrames = Math.min(
    Math.round(0.3 * fps),
    Math.max(2, Math.floor(totalFrames * 0.4)),
  );
  const inEnd = animFrames;
  const outStart = Math.max(inEnd, totalFrames - animFrames);

  const inProgress =
    animFrames === 0 ? 1 : Math.min(1, Math.max(0, frame / animFrames));
  const outProgress =
    animFrames === 0
      ? 0
      : Math.min(1, Math.max(0, (frame - outStart) / animFrames));

  let opacity = 1;
  let translateY = 0;
  let scale = 1;

  if (animation === "fade") {
    opacity = inProgress * (1 - outProgress);
  } else if (animation === "slide-up") {
    opacity = inProgress * (1 - outProgress);
    // Slide in from below, slide out upward.
    const inOffset = (1 - inProgress) * 80;
    const outOffset = outProgress * -80;
    translateY = inOffset + outOffset;
  } else if (animation === "zoom") {
    opacity = inProgress * (1 - outProgress);
    const inScale = 0.6 + inProgress * 0.4;
    const outScale = 1 - outProgress * 0.4;
    scale = Math.min(inScale, outScale);
  }

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: `${overlay.x * 100}%`,
          top: `${overlay.y * 100}%`,
          width: `${(overlay.widthFraction ?? 0.7) * 100}%`,
          transform: `translate(-50%, -50%) translateY(${translateY}px) scale(${scale})`,
          opacity: hidden ? 0 : opacity,
          fontSize: overlay.fontSize,
          fontFamily: isText
            ? fontFamilyFor(overlay.fontFamily)
            : "system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif",
          fontWeight: isText ? 700 : 400,
          color: isText ? (overlay.color ?? "#ffffff") : undefined,
          textShadow: isText ? "0 4px 32px rgba(0,0,0,0.55)" : undefined,
          lineHeight: 1.15,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          textAlign: "center",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {isText ? (
          overlay.content
        ) : (
          <img
            alt=""
            draggable={false}
            src={twemojiUrlFor(overlay.content)}
            style={{
              width: overlay.fontSize,
              height: overlay.fontSize,
              filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.35))",
              objectFit: "contain",
            }}
          />
        )}
      </div>
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
  const { fps } = useVideoConfig();
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

  // Pass trimBefore only when > 0. Passing a defined 0 makes Remotion wrap
  // the video in an extra <Sequence layout="none"> that interacts badly with
  // TransitionSeries.
  const videoTrimProps = startFrom > 0 ? { trimBefore: startFrom } : {};

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {isVideo ? (
        getRemotionEnvironment().isRendering ? (
          // Server-side render: OffthreadVideo extracts frames via canvas
          // instead of relying on <video> playback, which is more reliable
          // for remote MOV/MP4 files in headless Chrome.
          <OffthreadVideo
            muted
            src={item.src}
            {...videoTrimProps}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform,
            }}
          />
        ) : (
          <Video
            // Wide tolerance so brief drift (dev-mode render lag, codec stalls)
            // doesn't trigger backward seeks that the user perceives as the
            // clip repeating itself.
            acceptableTimeShiftInSeconds={10}
            muted
            pauseWhenBuffering={false}
            src={item.src}
            {...videoTrimProps}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform,
            }}
          />
        )
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
