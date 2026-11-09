import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Photo, Variant } from "../shared/types";
import type { GalleryMediaClient } from "./media";

export function GalleryImage(props: {
  media: GalleryMediaClient;
  photo: Pick<Photo, "id">;
  variant: Variant;
  alt: string;
  class?: string;
  loading?: "eager" | "lazy";
  decoding?: "sync" | "async" | "auto";
  fetchpriority?: "high" | "low" | "auto";
  onError?: () => void;
  [attribute: `data-${string}`]: string | undefined;
}) {
  const [src, setSrc] = createSignal("");
  const [failed, setFailed] = createSignal(false);
  const [retried, setRetried] = createSignal(false);
  let disposed = false;
  let generation = 0;
  createEffect(() => {
    const id = props.photo.id;
    const variant = props.variant;
    const requestGeneration = ++generation;
    setSrc("");
    setFailed(false);
    setRetried(false);
    void props.media.resolve(id, variant).then((url) => {
      if (!disposed && requestGeneration === generation) setSrc(url);
    });
    onCleanup(() => {
      if (generation === requestGeneration) generation++;
    });
  });
  onCleanup(() => {
    disposed = true;
  });
  return (
    <img
      src={src() || undefined}
      alt={props.alt}
      class={props.class}
      loading={props.loading}
      decoding={props.decoding}
      fetchpriority={props.fetchpriority}
      crossorigin="anonymous"
      onError={() => {
        const id = props.photo.id;
        const currentUrl = src();
        let isSignedR2 = false;
        try {
          isSignedR2 = new URL(currentUrl, window.location.href).hostname.endsWith(
            ".r2.cloudflarestorage.com",
          );
        } catch {
          /* Empty or malformed image URLs go to the regular error state. */
        }
        if (isSignedR2 && !retried()) {
          setRetried(true);
          const retryGeneration = generation;
          const variant = props.variant;
          void props.media.resolve(id, variant, true).then((url) => {
            if (disposed || retryGeneration !== generation) return;
            if (url && url !== currentUrl && url !== props.media.proxyUrl(id, variant)) {
              setSrc(url);
              return;
            }
            setFailed(true);
            props.media.noteProxyFallback();
            setSrc(props.media.proxyUrl(id, variant));
          });
          return;
        }
        if (!failed() && currentUrl !== props.media.proxyUrl(id, props.variant)) {
          setFailed(true);
          props.media.noteProxyFallback();
          setSrc(props.media.proxyUrl(id, props.variant));
          return;
        }
        props.onError?.();
      }}
      {...Object.fromEntries(
        Object.entries(props).filter(([key]) => key.startsWith("data-")),
      )}
    />
  );
}
