from __future__ import annotations


def guidance_for_failure(code: str) -> tuple[str | None, list[str]]:
    if code in {"missing_marker", "duplicate_marker"}:
        return "ruler_detection", [
            "Include the complete L-shaped ruler and all four AprilTags in the photograph.",
            "Keep IDs 0, 1, and 10 sharp, unobstructed, and surrounded by their white margins.",
            "Move the camera farther away if any ruler edge or marker is clipped.",
        ]
    if code in {"missing_length_marker", "ambiguous_length_marker", "unsupported_length_marker"}:
        return "ruler_detection", [
            "Include exactly one ruler-size AprilTag between corner markers 0 and 10.",
            "Ensure the fourth marker is sharp and its complete white margin is visible.",
            "Use a fourth-marker ID from 6 to 30, excluding the reserved corner ID 10.",
        ]
    if code in {"clipped_marker", "invalid_ruler_geometry", "invalid_homography", "canonical_crop_outside_image"}:
        return "ruler_geometry", [
            "Place the ruler flat and keep its complete outer boundary inside the photograph.",
            "Avoid folds, glare, shadows, and objects covering any marker.",
            "Hold the camera steady; rotation and perspective are corrected automatically when the ruler is complete.",
        ]
    if code in {"invalid_image_quality", "insufficient_resolution"}:
        return "image_validation", [
            "Retake in bright, even light and focus on the wound and ruler.",
            "Avoid digital zoom, motion blur, glare, and strong shadows.",
            "Use the original camera image rather than a screenshot or compressed copy.",
        ]
    if code == "wound_outside_photo":
        return "wound_detection", [
            "Step back so the wound and the skin around it are in the photo, up to the corner opposite the ruler's L.",
            "Hold the camera square-on above the wound; a tilted photo can push that corner out of the frame.",
            "When photographing a screen, zoom the picture out so nothing around the wound is cut off.",
        ]
    if code == "no_wound_detected":
        return "wound_detection", [
            "Confirm that a wound is visibly present and completely inside the ruler's measurement area.",
            "Retake with sharp focus, even lighting, and the wound clearly separated from surrounding skin.",
            "Do not record a zero measurement: request clinical review if repeated clear photographs are not detected.",
        ]
    return None, []
