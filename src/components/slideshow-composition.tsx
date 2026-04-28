import {
  AbsoluteFill,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Html5Audio,
  interpolate,
} from "remotion";
import type { TimelineMedia } from "@/lib/media";

type SlideshowCompositionProps = {
  images: TimelineMedia[];
  soundtrackSrc: string;
  secondsPerImage: number;
};

export function SlideshowComposition({
  images,
  soundtrackSrc,
  secondsPerImage,
}: SlideshowCompositionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const framesPerImage = secondsPerImage * fps;

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

      {images.map((image, index) => {
        const startFrame = index * framesPerImage;
        const progress = frame - startFrame;
        const scale = interpolate(
          progress,
          [0, framesPerImage],
          [1, 1.08],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          },
        );
        const opacity = interpolate(
          progress,
          [0, 8, framesPerImage - 8, framesPerImage],
          [0, 1, 1, 0],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          },
        );

        return (
          <Sequence key={image.id} durationInFrames={framesPerImage} from={startFrame}>
            <AbsoluteFill
              style={{
                alignItems: "center",
                justifyContent: "center",
                opacity,
              }}
            >
              <Img
                src={image.src}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  transform: `scale(${scale})`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background:
                    "linear-gradient(180deg, rgba(15, 23, 42, 0.08) 0%, rgba(15, 23, 42, 0.36) 100%)",
                }}
              />
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
          </Sequence>
        );
      })}

      <Html5Audio src={soundtrackSrc} volume={0.55} />
    </AbsoluteFill>
  );
}
