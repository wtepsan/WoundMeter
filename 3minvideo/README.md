# 3-minute demo video kit

Everything for recording and editing the WoundMeter demo video on a Mac.

## What's in this folder

| File / folder | What it is |
| :-- | :-- |
| [`script.md`](script.md) | The full script: 8 scenes with what to say, what to click, which tag to show, and the hackathon rules checklist. **Start here.** |
| [`teleprompter.txt`](teleprompter.txt) | Spoken text only, one block per scene, for reading while recording. |
| [`links.md`](links.md) | Pages to open, demo accounts and the submission link. |
| [`captions.srt`](captions.srt) | Subtitles for the spoken text, timed to the script (adjust after editing). |
| [`overlays/`](overlays) | 1920×1080 PNGs: title card, end card, and transparent **NEW / PRE-EXISTING** tags. |
| [`samples/`](samples) | The three sample ruler photos (A open, B small, C healed), CC BY 4.0. |
| [`logo/`](logo) | WoundMeter icon (PNG and SVG). |

## Which overlay goes where

The tag PNGs are full-frame and transparent: put one on a track above the video and it lands in the right corner by itself.

| Scene (time) | Overlay |
| :-- | :-- |
| Optional opener (2 s, before Scene 1) | `00-title-card.png` |
| 1 · The problem (0:00–0:20) | none |
| 2 · What it is, and what's new (0:20–0:40) | `01-tag-new-built-during-hackathon.png` |
| 3 · SAM 3.1 outline (0:40–1:15) | first 5 s: `02-tag-pre-existing-ruler-measurement.png`; then `03-tag-new-sam-and-boundary-editor.png`; while saying "my older YOLO model": `09-tag-pre-existing-yolo-model.png` |
| 4 · Muse Spark & sign-off (1:15–1:40) | `04-tag-new-muse-spark-and-signoff.png` |
| 5 · No visible wound (1:40–2:00) | `05-tag-new-no-visible-wound.png` |
| 6 · Connected care (2:00–2:30) | `06-tag-new-connected-care.png` |
| 7 · Contributions (2:30–2:50) | `07-tag-public-repo.png` (top right) |
| 8 · Close (2:50–3:00) | `08-tag-image-credit.png`, or end on `10-end-card.png` |

Whenever sample photos are on screen, `08-tag-image-credit.png` can stay at the bottom; it doesn't clash with the tags in the top-right.

If you add the title card, keep the total under 3:00: trim Scene 6 first.

## Make the video on a Mac

**1. Download this folder.** In VS Code (connected to the VM): Explorer → right-click `3minvideo` → **Download…**. Or, once the repo is pushed, download it from GitHub.

**2. Prepare the browser** using [`links.md`](links.md): Chrome, full screen, zoom 100–110%, bookmarks bar hidden, notifications off (Focus → Do Not Disturb).

**3. Record scene by scene.**
- Press **⌘ Shift 5** → **Record Selected Portion** (the browser window) → **Options** → choose your microphone → **Record**. Stop with the ■ in the menu bar.
- Read each scene from `teleprompter.txt` (a second screen or a phone helps). Re-take only the scene you stumble in.
- Alternative: record the screen silently, then record the voice in QuickTime (**File → New Audio Recording**) and line them up in the editor.

**4. Edit** (iMovie is free; CapCut also works).
- Import the scene clips in order, and the PNGs from `overlays/`.
- **iMovie:** drag a tag PNG onto the track *above* a clip → in the viewer's overlay menu choose **Cutaway** (transparency is kept) → drag its edges to match the scene times.
- **CapCut:** drag a PNG onto an overlay track above the clip and stretch it to the scene.
- Cut every wait (measuring, loading) or speed it up 2×. Aim for **2:50–3:00**.

**5. Export** at **1080p**. Check the length is **≤ 3:00** and the sound is clear at laptop volume.

**6. Upload** to YouTube as **Unlisted** (or Loom). On YouTube: **Studio → Subtitles → Add → Upload file → With timing** → `captions.srt` (fix any timing drift there). Open the link in a private window to check it plays signed-out.

**7. Submit** (see [`links.md`](links.md)): public repo, video link, team member(s), one track, before **Wed 4 Nov, 9:00 PM ET**.

## Credits to keep

Sample photos: adapted from Jia et al. (2026), Figure 3 (https://doi.org/10.3389/fmed.2026.1776438), licensed under CC BY 4.0. The credit is in `08-tag-image-credit.png`, the end card and the app itself.
