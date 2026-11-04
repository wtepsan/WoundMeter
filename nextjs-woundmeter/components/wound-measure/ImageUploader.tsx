"use client";

import { useRef, useState } from "react";
import { Camera, CheckCircle2, Images, Upload } from "lucide-react";

export function ImageUploader({
  file,
  previewUrl,
  disabled,
  onSelect,
  title = "Take or choose a photograph",
  hint = "On a phone or tablet, Take photo opens the rear camera.",
  showCameraButton = true,
}: {
  file: File | null;
  previewUrl: string | null;
  disabled: boolean;
  onSelect: (file: File | null) => void;
  /** Visible heading; pass null when the surrounding page already has one. */
  title?: string | null;
  hint?: string;
  /** Hide the file-input "Take photo" button (it opens a camera on mobile browsers only). */
  showCameraButton?: boolean;
}) {
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const selectInputFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    onSelect(event.target.files?.[0] ?? null);
    // Permit selecting or retaking a file with the same generated filename.
    event.target.value = "";
  };

  return (
    <section className="uploader" aria-label={title ?? "Photo"}>
      {title && <h2 className="section-title">{title}</h2>}
      <button
        type="button"
        className={`drop-zone ${dragging ? "dragging" : ""}`}
        disabled={disabled}
        onClick={() => libraryInputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          onSelect(event.dataTransfer.files[0] ?? null);
        }}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
          <img src={previewUrl} alt="Selected wound photograph" />
        ) : (
          <span className="drop-copy">
            <Upload aria-hidden="true" />
            <strong>Drop a photo here or choose one</strong>
            <small>JPEG, PNG or WebP · up to 10 MB</small>
          </span>
        )}
      </button>

      {file && (
        <p className="upload-selected" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span><strong>Photo selected</strong> {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB</span>
          <button type="button" className="link-button" disabled={disabled} onClick={() => onSelect(null)}>Remove</button>
        </p>
      )}

      {/* Once a photo is chosen, the next step is the page's own action; these become secondary. */}
      <div className="upload-source-actions" aria-label="Photo source">
        {showCameraButton && (
          <button type="button" className={`button ${file ? "secondary" : "primary"}`} disabled={disabled} onClick={() => cameraInputRef.current?.click()}>
            <Camera aria-hidden="true" />
            {file ? "Retake photo" : "Take photo"}
          </button>
        )}
        <button type="button" className="button secondary" disabled={disabled} onClick={() => libraryInputRef.current?.click()}>
          <Images aria-hidden="true" />
          {file ? "Choose another" : "Choose from library"}
        </button>
      </div>
      {hint && <p className="field-hint">{hint}</p>}

      <input
        ref={libraryInputRef}
        className="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={disabled}
        onChange={selectInputFile}
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={cameraInputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={disabled}
        onChange={selectInputFile}
        tabIndex={-1}
        aria-hidden="true"
      />
    </section>
  );
}
