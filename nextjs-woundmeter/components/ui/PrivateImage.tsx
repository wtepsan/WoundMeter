"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";

import { imageProxyUrl } from "@/lib/care-api";
import type { SignedImageRef } from "@/lib/care-types";

/** Private wound photo served through an expiring, viewer-bound signed URL. */
export function PrivateImage({
  image,
  alt,
  className,
}: {
  image: SignedImageRef | null | undefined;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) {
    return (
      <div className={`image-placeholder ${className ?? ""}`}>
        <ImageOff aria-hidden="true" />
        <span>{image ? "Image unavailable" : "No approved image yet"}</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- private proxied bytes, not a static asset
    <img
      className={className}
      src={imageProxyUrl(image.signed_url)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Prefer the calibrated (rectified) view; fall back to the original upload. */
export function pickDisplayImage(images: SignedImageRef[]): SignedImageRef | null {
  return (
    images.find((i) => i.image_role === "CANONICAL_RECTIFIED") ??
    images.find((i) => i.image_role === "ORIGINAL_UPLOAD") ??
    null
  );
}
