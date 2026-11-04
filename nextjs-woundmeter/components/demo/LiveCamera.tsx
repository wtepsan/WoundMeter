"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, SwitchCamera, X } from "lucide-react";

/**
 * In-browser camera (getUserMedia) for laptops and phones, shown full screen over the app. After
 * Capture it closes and the photo is handed back, so the user returns to the same step.
 * The `capture` file-input attribute only opens a camera on mobile browsers; this works anywhere the
 * browser allows camera access, which requires a secure context (https:// or http://localhost).
 */

type Problem = { title: string; steps: string[]; detail?: string };

function isChrome() {
  return typeof navigator !== "undefined" && /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent);
}

function describe(err: unknown): Problem {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
  const browser = isChrome() ? "Google Chrome" : "this browser";
  if (name === "NotAllowedError" || name === "SecurityError") {
    const bySystem = /system/i.test(message);
    return {
      title: bySystem ? `macOS is blocking the camera for ${browser}` : "Camera permission is blocked",
      detail: `${name}: ${message}`,
      steps: [
        ...(bySystem || mac ? [`On the Mac: System Settings → Privacy & Security → Camera → turn on ${browser}. Then quit and reopen ${browser} completely (Cmd+Q).`] : []),
        isChrome()
          ? "In Chrome: click the camera icon (or the tune icon) at the left of the address bar → Camera → Allow, then reload. Or open chrome://settings/content/camera and remove localhost:14456 from “Not allowed”."
          : "Allow camera access for this site in the browser's site settings, then reload.",
      ],
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "The camera is busy or couldn't start",
      detail: `${name}: ${message}`,
      steps: ["Close other apps or tabs using the camera (another browser, Zoom, Teams, FaceTime), then press Try again."],
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { title: "No camera was found", detail: `${name}: ${message}`, steps: ["Connect a camera, or use “Choose from library”."] };
  }
  return { title: "The camera couldn't be started", detail: `${name || "Error"}: ${message}`, steps: ["Press Try again, or use “Choose from library”."] };
}

export function LiveCamera({ disabled, onCapture }: { disabled: boolean; onCapture: (file: File) => void }) {
  const [open, setOpen] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [starting, setStarting] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIndex, setDeviceIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const start = useCallback(async (deviceId?: string) => {
    stopStream();
    setProblem(null);
    if (!window.isSecureContext) {
      setProblem({
        title: "The camera needs a secure address",
        steps: ["Browsers only allow the camera on https:// or http://localhost. Open WoundMeter through the SSH tunnel at http://localhost:14456/demo."],
      });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem({ title: "This browser doesn't support camera access", steps: ["Use “Choose from library” instead."] });
      return;
    }
    setStarting(true);
    // Ask for a sharp rear camera first; if the browser or camera refuses those settings, fall back to defaults.
    const attempts: MediaStreamConstraints[] = [
      { audio: false, video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
      { audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true },
    ];
    let lastError: unknown = null;
    for (const constraints of attempts) {
      try {
        const next = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = next;
        setStream(next);
        setStarting(false);
        navigator.mediaDevices.enumerateDevices()
          .then((all) => setDevices(all.filter((d) => d.kind === "videoinput")))
          .catch(() => undefined);
        return;
      } catch (err) {
        lastError = err;
        const name = err instanceof DOMException ? err.name : "";
        // A permission refusal won't change with other settings.
        if (name === "NotAllowedError" || name === "SecurityError") break;
      }
    }
    setStarting(false);
    setProblem(describe(lastError));
  }, [stopStream]);

  // The stream is attached whenever both it and the <video> exist, whichever comes first.
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => undefined);
    }
  }, []);
  useEffect(() => { attachVideo(videoRef.current); }, [stream, attachVideo]);

  const close = useCallback(() => {
    stopStream();
    setProblem(null);
    setOpen(false);
  }, [stopStream]);

  useEffect(() => {
    if (!open) return;
    void start();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, start, close]);
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) {
        setProblem({ title: "The photo couldn't be captured", steps: ["Press Try again."] });
        return;
      }
      close();
      onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  };

  const switchCamera = () => {
    if (devices.length < 2) return;
    const next = (deviceIndex + 1) % devices.length;
    setDeviceIndex(next);
    void start(devices[next].deviceId);
  };

  return (
    <>
      <button type="button" className="button primary" disabled={disabled} onClick={() => setOpen(true)}>
        <Camera aria-hidden="true" />
        Use camera
      </button>
      {open && (
        <div className="camera-overlay" role="dialog" aria-modal="true" aria-label="Camera">
          <div className="camera-stage">
            {stream && <video ref={attachVideo} playsInline muted autoPlay aria-label="Camera preview" />}
            {starting && !stream && <p className="camera-message">Starting camera… allow access if the browser asks.</p>}
            {problem && (
              <div className="camera-problem" role="alert">
                <strong>{problem.title}</strong>
                <ol>{problem.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                {problem.detail && <p className="camera-detail">{problem.detail}</p>}
              </div>
            )}
          </div>
          <div className="camera-bar">
            <p className="camera-hint">Fit the whole L-shaped ruler (all four markers) and the wound in the frame, hold steady.</p>
            <div className="camera-actions">
              <button type="button" className="button secondary" onClick={close}><X aria-hidden="true" /> Cancel</button>
              {problem ? (
                <button type="button" className="button primary" onClick={() => void start()}>Try again</button>
              ) : (
                <button type="button" className="camera-shutter" disabled={!stream} onClick={capture} aria-label="Capture photo">
                  <span />
                </button>
              )}
              <button type="button" className="button secondary" disabled={devices.length < 2 || Boolean(problem)} onClick={switchCamera}>
                <SwitchCamera aria-hidden="true" /> Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
