"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import Image from "next/image";

interface VideoProps {
  src: string;
  mobileSrc?: string;
  className?: string;
  poster?: string;
  stillPoster?: string;

  onLoadStart?: () => void;
  onLoadedData?: () => void;
  onError?: () => void;
}

function Video({
  src,
  mobileSrc,
  className,
  poster,
  stillPoster,
  onLoadStart,
  onLoadedData,
  onError,
  ...props
}: VideoProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [isLowPowerMode, setIsLowPowerMode] = React.useState(false);

  const clearAllVideoSources = React.useCallback((video: HTMLVideoElement) => {
    video.removeAttribute("src");
    const sources = video.querySelectorAll("source");
    sources.forEach((source) => {
      source.removeAttribute("src");
    });

    video.load();
  }, []);

  const restoreVideoSources = React.useCallback(
    (video: HTMLVideoElement) => {
      if (!video.dataset.originalSources) return;

      const sourcesData = JSON.parse(video.dataset.originalSources);
      const sources = video.querySelectorAll("source");

      sources.forEach((source, index) => {
        if (sourcesData[index]) {
          source.src = sourcesData[index].src;
          source.type = sourcesData[index].type;
          if (sourcesData[index].media) {
            source.media = sourcesData[index].media;
          }
        }
      });

      video.load();

      const onLoaded = () => {
        video.play().catch(() => {
          clearAllVideoSources(video);
        });
        video.removeEventListener("loadeddata", onLoaded);
      };

      video.addEventListener("loadeddata", onLoaded);
    },
    [clearAllVideoSources],
  );

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;

    if (!video.dataset.originalSources) {
      const sources = video.querySelectorAll("source");
      const sourcesData = Array.from(sources).map((source) => ({
        src: source.src,
        type: source.type,
        media: source.media || "",
      }));
      video.dataset.originalSources = JSON.stringify(sourcesData);
    }

    const handleAutoplayFailure = () => {
      clearAllVideoSources(video);
    };

    video.addEventListener("error", handleAutoplayFailure);

    const originalPlay = video.play;
    video.play = function () {
      return originalPlay.call(this).catch((error) => {
        if (error instanceof Error && error.name === "NotAllowedError") {
          setIsLowPowerMode(true);
          clearAllVideoSources(video);
        } else {
          handleAutoplayFailure();
        }
        return Promise.resolve();
      });
    };

    const checkInitialAutoplay = () => {
      if (video.readyState >= 2) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            if (error instanceof Error && error.name === "NotAllowedError") {
              setIsLowPowerMode(true);
              clearAllVideoSources(video);
            }
          });
        }
      }
    };

    const onCanPlay = () => {
      checkInitialAutoplay();
      video.removeEventListener("canplay", onCanPlay);
    };
    video.addEventListener("canplay", onCanPlay);

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (isLowPowerMode) return;

          if (entry.isIntersecting) {
            restoreVideoSources(video);
          } else {
            video.pause();
            clearAllVideoSources(video);
          }
        });
      },
      { threshold: 0, rootMargin: "200px" },
    );

    observer.observe(video);

    return () => {
      observer.disconnect();
      video.removeEventListener("error", handleAutoplayFailure);
    };
  }, [clearAllVideoSources, restoreVideoSources, isLowPowerMode]);

  if (isLowPowerMode && (stillPoster || poster)) {
    return (
      <Image
        src={stillPoster ?? poster!}
        alt=""
        width={0}
        height={0}
        sizes="100vw"
        className={cn("absolute object-cover", className)}
        {...props}
      />
    );
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      loop
      muted
      playsInline
      preload="none"
      poster={poster}
      className={cn(
        "auto_video absolute mask-[linear-gradient(#000_1px,#000_calc(100%-1px))] object-cover [-webkit-mask-image:linear-gradient(#000_1px,#000_calc(100%-1px))]",
        className,
      )}
      onLoadStart={onLoadStart}
      onLoadedData={onLoadedData}
      onError={onError}
      {...props}
    >
      <source src={src} type="video/webm" media="(min-width: 768px)" />
      <source
        src={mobileSrc || src}
        type="video/webm"
        media="(max-width: 769px)"
      />
      Your browser does not support the video tag.
    </video>
  );
}

export default Video;
