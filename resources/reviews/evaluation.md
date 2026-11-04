# WoundMeter: Hackathon Submission Self-Evaluation

**Prepared:** 4 November 2026, by the developer with AI assistance. This is a self-assessment against the hackathon rules, not an independent or official judging score.
**Live:** https://woundmeter.wtepsan.dev · [/demo](https://woundmeter.wtepsan.dev/demo) · [/instruction](https://woundmeter.wtepsan.dev/instruction)
**Overview:** [README](../../README.md) · **Implementation and evidence:** [TECHNICAL_DETAILS](../../docs/TECHNICAL_DETAILS.md)

---

## 1. Problem

Older adults confined to bed develop pressure wounds quickly, and more of them are cared for at home by family without clinical training. Professionals cannot review every wound in person every day. Phone photos taken at different distances and angles cannot be compared. WoundMeter links home monitoring to clinician-verified records under one rule: **AI assists. Families care. Professionals decide.** The idea comes from the developer's earlier elderly-care research, which fits the **Build for Your World** theme.

WoundMeter does not decide whether a wound is healing. It provides measurements and drafts; a clinician verifies them, and only a clinician can mark a wound healed.

## 2. Innovation

- **YOLO-guided SAM 3.1.** The local model chooses where SAM looks; SAM finds the edge using box and point prompts. This fixed real failure cases: pen-mark dashes, the whole pink healing zone and healed scar had been outlined as wound. When neither model finds an open wound, the photo is reported as **No visible wound detected** and can be recorded as 0 cm² only after a clinician confirms it.
- **A decoder for SAM 3.1's compressed mask format**, written for this project (`sam_codec.py`).
- **Grounded documentation.** Muse Spark works only from server-computed figures, with fixed JSON schemas. A tool-calling record assistant reads approved data only and creates unsigned drafts only.
- **Human authority built into the record.** Every boundary edit is a new version. Sign-off requires four explicit confirmations, and an edit makes the earlier AI draft out of date. The audit log is hash-chained, and families see only signed results.

## 3. Meta model usage

| Model | Use | Human check | Evidence |
| :--- | :--- | :--- | :--- |
| SAM 3.1 | Wound boundary proposal on the straightened, metadata-free crop | Clinician accepts, picks an alternative or redraws | `meta_client.py`, `sam_guidance.py`, `sam_codec.py`; live calls of 4.5–5.4 s recorded on the server |
| Muse Spark 1.3 | Measurement explanation, visual observations, Ask AI rewording, reports, record assistant (8 tools) | Accept, edit or reject; reports signed by a clinician | `clinical_ai_service.py`, `api/clinical_ai.py` |
| Muse Voice Transcribe 1.0 | Dictation into the assistant's text box; audio not stored | User checks the text before sending | `clinical_ai_service.py`, `lib/wav-recorder.ts`; not tested with live audio in this review |

Code computes every measurement, never a language model. If the Meta API fails, WoundMeter falls back to YOLOv8 and to template text.

## 4. Demonstrated results

| Result | Status |
| :--- | :--- |
| `/`, `/demo`, `/instruction` and the sample images load over HTTPS | Checked 4 Nov 2026, about 22:00 UTC |
| `/demo` runs the full pipeline on the built-in sample photos without sign-in, saving nothing | Checked during development |
| End-to-end API run of measurement, sign-off rules, 0 cm², healing and reopening, and caregiver permissions | 29/29 passed during development (script not committed) |
| YOLO-guided SAM on a few real photos: pen marks, healing zone and scar no longer measured as wound | Shown on a handful of photos; not a validation study |
| Frontend type check and production build | Pass (they run in every Docker image build) |
| Ruler accuracy on a synthetic image (0–30° tilt, area error under 1%) | Pass, but this tests a **pre-existing** feature |

The sample photos are adapted from a published case report (Jia Z. et al. 2026, CC BY 4.0), with the ruler added digitally. Their cm² values show how the workflow behaves; they are not true wound sizes.

## 5. Hackathon eligibility

### 5.1 Pre-existing and new work

| Category | Items |
| :--- | :--- |
| **Pre-existing, reused as-is** | YOLOv8 wound model `best.pt` (Aug 2025) |
| **Pre-existing, code adapted** | AprilTag L-ruler, geometric correction and physical measurement (`ruler_template_v1.yaml`, Aug 2026; ruler illustration, Aug 2026) |
| **Pre-existing concept** | Linking family caregivers with professional review, from earlier joint research |
| **New, 26 Oct–4 Nov 2026** | SAM 3.1 integration and decoder; Muse Spark and Muse Voice features; colour calibration (profile dated 30 Oct); boundary correction and versioning; clinician sign-off and audit log; multi-role platform; no-visible-wound and 0 cm² workflow; `/demo`, `/instruction`, PWA, documentation and deployment |

The repository was created on 4 November 2026, so its commit history cannot show when the work was done during the window. The split rests on file dates, the model checksum, dates written inside configuration files, and leftover `woundwise` identifiers.

### 5.2 Rule audit

"Confirmed" means checked on the public event page or by a live check. "Supplied" means taken from the rules text the developer supplied; the public event page does not repeat it.

| Requirement | Source | Finding |
| :--- | :--- | :--- |
| Submit by 4 Nov 2026, 9:00 PM ET | Confirmed | **Open:** submission not yet made |
| One track: Indie Developer (creativity, technical ambition, whether it works) or Startup (execution, production readiness) | Confirmed | **Open:** track not yet chosen. A solo entry fits Indie Developer |
| Themes: Build for Your World / Push the Frontier | Confirmed | Build for Your World, stated in the README |
| Only new work; pre-existing work identified | Supplied | Identified in the README and in §5.1. Risk: no commit history from inside the window |
| Public repository | Confirmed live | `github.com/wtepsan/WoundMeter` loads signed-out (HTTP 200) |
| Demo video of 3 minutes or less | Supplied | **Open:** video not yet recorded and linked |
| No AI medical or health advice; not a simple image analyser | Supplied | README and app state no advice, diagnosis or staging. The full workflow, from capture to signed history, goes beyond a single image analysis |
| Rights to assets | Supplied | Sample images are CC BY 4.0, credited with the changes made. No `LICENSE` file for the code |
| No credentials or private data in the repository | Checked | No keys or tokens in tracked files; `.env`, model weights and `demo-data/` are git-ignored. The demo patient is fictional |

## 6. Open risks

1. **Track and video.** Choose one track, record the video and add its link before the deadline.
2. **Provenance evidence.** The repository history starts on 4 Nov, so judges must rely on the documented evidence.
3. **Demo uploads kept on the server.** `WOUNDMETER_DEMO_KEEP_PHOTOS=true` saves photos uploaded to `/demo` on the server (not in the repository). If a visitor uploads a real wound photo, it is retained. Recommend turning it off for public judging and clearing the earlier test photos.
4. **No automated test suite or `LICENSE`** in the repository.
5. **Not validated.** There is no clinical study and no physical calibration of the printed ruler or colour patches. YOLO-guided SAM has been checked on a handful of photos only.

## 7. Verdict

**NEEDS ATTENTION.** The software, live demo, Meta model use and provenance documentation are in place. The track choice and the video link (both required) are still missing, and the open risks above should be accepted knowingly.
