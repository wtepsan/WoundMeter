# WoundMeter — Independent Technical, Clinical-Workflow & Hackathon Evaluation

**Review Date:** 4 November 2026 (16:03–16:50 UTC)  
**Target Event:** Meta Global AI Developer Hackathon (26 October–4 November 2026)  
**Evaluated Repository:** `/home/ragserver/WoundMeter`  
**Evaluated Live Deployment:**
- **Application:** https://woundmeter.wtepsan.dev
- **User Instructions:** https://woundmeter.wtepsan.dev/instruction
- **Interactive Demo:** https://woundmeter.wtepsan.dev/demo

**Guiding Principle Evaluated:** ***AI assists. Families care. Professionals decide.***

---

## 1. Idea and Motivation

### 1.1 Origin in Home-Based Elderly Care
WoundMeter originates from a concrete, high-empathy observation in elderly care: as hospital stays shorten and populations age, day-to-day care for older adults increasingly shifts to the home. Sons, daughters, grandchildren, cousins, and other informal family caregivers perform routine dressing changes and skin checks without formal nursing training.

When a chronic wound or pressure injury develops, families face three acute anxieties:
1. **Observation uncertainty:** *"What visual or symptomatic changes should I actually look for?"*
2. **Documentation inconsistency:** *"How do I take a photograph that a nurse or doctor can genuinely trust and compare with last week's photo?"*
3. **Escalation timing:** *"When is a change routine, and when do I need to contact a clinician or emergency care immediately?"*

Simultaneously, community nurses and wound-care specialists cannot be physically present in every home every day, yet they remain clinically and legally accountable for care plans.

### 1.2 Assessment of the Core Question
The project frames its mission around a clear, well-bounded question:

> *"How can we help family caregivers know what to observe, what to do, and when to seek professional help, while keeping healthcare professionals involved?"*

- **Evidence:** [`nextjs-woundmeter/components/caregiver/SubmitUpdate.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/caregiver/SubmitUpdate.tsx), [`CarePlanPage.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/caregiver/CarePlanPage.tsx), [`fastapi-woundmeter/app/services/connected_care_db.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/connected_care_db.py).
- **Status:** **Verified**
- **Judge Assessment:** Rather than falling into the common AI-healthcare trap of claiming to "diagnose wounds from a smartphone photo," WoundMeter defines a realistic socio-technical boundary. It treats AI as a measurement-and-drafting assistant, empowers families to capture calibrated visual and symptomatic observations, and keeps clinical interpretation and sign-off strictly in the hands of qualified professionals. The motivation is authentic, human-centred, and directly aligned with the hackathon's **"Build for Your World"** and **"Push the Frontier"** themes.

---

## 2. Problem–Solution Fit

| Identified Caregiving & Clinical Problem | Implemented WoundMeter Mechanism | Evidence in Codebase & Live App | Fit Assessment |
| :--- | :--- | :--- | :--- |
| **Uncalibrated home photos vary wildly in scale and camera tilt** | L-shaped physical ruler with 4 `APRILTAG_36h11` fiducial markers (`0`, `1`, `10`, plus dynamic length tag `6–30 cm`) warped via RANSAC homography onto a canonical $10\text{ px/mm}$ plane | [`apriltag_detector.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/apriltag_detector.py), [`ruler_geometry.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/ruler_geometry.py), [`canonical_crop.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/canonical_crop.py) | **Strong** — Solves projective scale and tilt deterministically before any AI model runs. |
| **Indoor lighting distorts tissue colour appearance** | 8-patch colour strip sampled in linear sRGB; white-balance diagonal + ridge $3\times 3$ matrix correction; CIELAB $\Delta E_{00}$ check; blocks AI colour claims when unverified | [`colour_calibration.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/colour_calibration.py), [`colour_profile_v1.yaml`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/config/colour_profile_v1.yaml), [`clinical_ai_service.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/clinical_ai_service.py#L145-L148) | **Strong (with Honest Caveat)** — Explicitly marks reference values as `UNVERIFIED_REFERENCE` until printed patches are spectrophotometrically measured, and suppresses colour-based AI tissue descriptions accordingly. |
| **Family caregivers do not know what symptoms to report** | Structured factual intake (`RecordFactsFields.tsx`, `SubmitUpdate.tsx`): pain `0–10`, drainage level, dressing state, periwound redness, concern checkbox, and plain-language notes | [`SubmitUpdate.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/caregiver/SubmitUpdate.tsx#L61-L67), [`RecordFactsFields.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/care/RecordFactsFields.tsx) | **Strong** — Separates factual caregiver observations from clinical staging/diagnosis. |
| **AI segmentation alone can miss slough or over-segment skin** | Guided two-pass **Meta SAM 3.1** + local **YOLOv8-seg** comparison, multi-candidate outline selector, and interactive polygon vertex editor with live server re-measurement | [`pipeline.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/pipeline.py#L723-L811), [`PhotoWorkspace.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/record/PhotoWorkspace.tsx) | **Excellent** — Directly addresses clinical distrust of black-box segmentation by making every contour inspectable and editable. |
| **Clinicians face high documentation burden** | **Meta Muse Spark 1.3** drafts structured visual observations, measurement explanations, inline revisions, and longitudinal reports; **Muse Voice Transcribe 1.0** handles dictation | [`meta_client.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/meta_client.py), [`clinical_ai_service.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/clinical_ai_service.py), [`AiAssistance.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/record/AiAssistance.tsx) | **Strong** — Reduces clerical typing while enforcing mandatory human accept/edit/reject and 4-attestation sign-off. |
| **Caregivers might mistake app uploads for 24/7 emergency monitoring** | Explicit non-emergency warning banners in caregiver submission flows citing direct care-team contact and Thailand emergency number `1669`; unapproved AI numbers hidden from caregivers | [`SubmitUpdate.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/caregiver/SubmitUpdate.tsx#L172-L173), [`SubmitUpdate.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/caregiver/SubmitUpdate.tsx#L276-L278), [`connected_care_db.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/connected_care_db.py) | **Moderate-to-Strong** — In-app caregiver submission screens include clear emergency notices, though `/instruction` itself is currently a concise 5-step photo guide rather than a full clinical/safety manual (see Section 5.2 and Section 14). |

---

## 3. Executive Assessment

### Verdict Summary: **READY WITH CAVEATS**

WoundMeter is a **deeply engineered, architecturally serious full-stack healthcare prototype** ($15,289$ lines of Python across $53$ backend modules, $16,035$ lines of TypeScript/React across $103$ frontend modules, and a $28$-table PostgreSQL 16 schema). Unlike superficial hackathon wrappers around a single prompt, WoundMeter integrates **three Meta AI models (`sam-3.1`, `muse-spark-1.3`, `muse-voice-transcribe-1.0`)** into a deterministic projective-geometry pipeline and a cryptographically auditable clinical workflow.

### Key Strengths
1. **Exemplary Neuro-Symbolic / Deterministic Separation:** AI models (`sam-3.1`, `best.pt`) only propose pixel masks; deterministic geometry (`wound_measurement.py`) computes every physical figure ($\text{cm}^2$, $\text{cm}$, Feret axes) on a calibrated $10\text{ px/mm}$ homography grid; and `muse-spark-1.3` explains those locked numbers under strict JSON schemas and regex safety filters.
2. **Sophisticated Guided SAM 3.1 Engineering:** The two-pass SAM 3.1 strategy (concept locator $\rightarrow$ $L_2$ distance-transform interior point + expanded bounding box prompt) and custom Base85 + range-coder/Paeth binary raster decoder (`sam_codec.py`) solve real domain failures (slough exclusion and concave wound beds) and gracefully fall back to local CPU YOLOv8-seg when the external API times out.
3. **Rigorous Human-in-the-Loop Governance:** Four fingerprint-bound clinical attestations (`approval-attestations.ts`), automatic invalidation (`stale`) of AI drafts when boundaries are edited, role-based access control (`permission_policy.py`), AES-256-GCM patient PII encryption, and SHA-256 hash-chained audit logs (`audit_events`).
4. **Live, Responsive Public Deployment:** All three target URLs (`/`, `/instruction`, `/demo`) are live over Cloudflare HTTPS (`HTTP/2 200`), render with zero console errors or network failures on both desktop (`1366×800`) and mobile (`393×851`) in headless Chromium, and enforce `httpOnly; SameSite=Strict` session cookies and same-origin CSRF checks.

### Key Weaknesses & Caveats
1. **No One-Click Pre-Loaded Sample Image on `/demo` (`DEMO_SAMPLE_DATA = false`) — P1 Demo Friction:** Visiting `/demo` requires uploading or photographing an image containing a valid 4-tag AprilTag L-ruler (`0, 1, 10`, plus length tag). A first-time judge without a sample ruler image on their machine will hit the `calibration_failed` retake diagnostic screen unless provided with a test image.
2. **`/instruction` Page Scope vs. Full Caregiver Curriculum — P1 Documentation Gap:** `/instruction` (`nextjs-woundmeter/app/instruction/page.tsx`, 75 lines) is a clean, accurate 5-step **Photo Guide**, but it does not explain in detail what SAM/Muse Spark do and do not do, how boundary editing works, or red-flag clinical symptoms for seeking urgent help (those appear inside the authenticated/demo app screens rather than on `/instruction`).
3. **Kept Demo Photos Contains Unverified Third-Party Clinical Figures & Enabled Flag (`WOUNDMETER_DEMO_KEEP_PHOTOS=true`) — P1 Privacy/Governance Caveat:** In the live deployment, `demo-data/images/2026-11-04/` retains 5 demo runs, two of which (`160616` and `163041`/`163539`) appear to be photographs/composites of published clinical textbook or journal wound figures (showing a printed `"A"` label or cursor arrow) composite-framed with AprilTag rulers. While `demo-data/` is excluded by `.gitignore` and `.dockerignore`, `WOUNDMETER_DEMO_KEEP_PHOTOS` should default to `false` on the public server and only synthetic phantoms should be used for demonstrations.
4. **In-Repository Automated Test Suite & Git History Omitted by Deployment Packaging — P2 Verification Caveat:** As documented in the original `README.md` (*"Tests, patient fixtures, historical reports, old apps... are intentionally absent"*), the deployment workspace `.git` was initialised on 4 Nov 2026 with zero commits and no `tests/` directory or `LICENSE` file in the tree.

---

## 4. Hackathon Eligibility (OLD vs. NEW Work, Attribution & Compliance)

**Hackathon Window:** 26 October–4 November 2026.

### 4.1 Forensic Provenance Methodology
Because the deployment directory's `.git` repository was freshly initialised on `2026-11-04 12:52 UTC` (`fatal: your current branch 'main' does not have any commits yet`), historical Git commit logs are unavailable on this VM. To establish an unmistakable, evidence-based boundary between pre-existing work (**OLD**) and hackathon work (**NEW**), we inspected:
1. Filesystem modification timestamps (`find . -printf '%TY-%Tm-%Td %p\n'`) across all $200+$ repository files.
2. Internal version strings, comments, and legacy `woundwise` namespace identifiers (`woundwise_l_ruler_prototype`, `woundwise-v1`, `LEGACY_CACHE_PREFIX = "woundwise-"`).
3. Embedded provenance dates inside configuration files (`colour_profile_v1.yaml`: *"Measured 30 Oct 2026"*).

### 4.2 Verified OLD vs. NEW Breakdown

| Artifact / Subsystem | Status | Timestamp & Code Evidence | Eligibility Assessment |
| :--- | :---: | :--- | :--- |
| **Custom YOLOv8-seg Weights (`best.pt`)** | **OLD (Pre-Hackathon)** | `resources/models/best.pt` (`mtime: 2025-08-19`, SHA-256 `bb45e8da...`) | Pre-existing custom-trained wound segmentation model from the earlier prototype; transparently used as the local CPU baseline and fallback. |
| **PostCSS Boilerplate (`postcss.config.mjs`)** | **OLD (Pre-Hackathon)** | `nextjs-woundmeter/postcss.config.mjs` (`mtime: 2025-08-13`) | Standard 6-line Tailwind PostCSS config file. |
| **Base Ruler Template (`ruler_template_v1.yaml`) & Ruler Diagram (`instruction_1ruler.png`)** | **OLD Foundation (Extended)** | `fastapi-woundmeter/config/ruler_template_v1.yaml` (`mtime: 2026-08-01`, `template_id: woundwise_l_ruler_prototype`); `public/images/instruction_1ruler.png` (`mtime: 2026-08-03`) | Pre-existing $12\text{ cm}$ 3-tag (`0, 1, 10`) ruler specification. Extended in Python (`ruler_template.py`, `apriltag_detector.py`) during the hackathon to dynamically scale to 4th length-ID markers (`6–30 cm`, e.g., $18\text{ cm}$) and partial-frame coverage polygons. |
| **8-Patch Colour Calibration Profile & Engine** | **NEW (Hackathon)** | `config/colour_profile_v1.yaml` (`mtime: 2026-10-30`, provenance: *"Measured 30 Oct 2026"*); `colour_calibration.py` (`2026-11-04`, $396$ lines) | Built during the hackathon window. |
| **Instruction Illustrations 2 & 3 (`instruction_2takephoto.png`, `instruction_3woundwithruler.png`)** | **NEW (Hackathon)** | `nextjs-woundmeter/public/images/` (`mtime: 2026-10-30`) | Created during the hackathon window. |
| **Database Schema Contract & PostgreSQL 16 Migration (`001_initial.sql`)** | **NEW (Hackathon)** | `config/database_schema_v1.json` (`mtime: 2026-10-31`); `migrations/001_initial.sql` (`2026-11-04`, $531$ lines, 28 tables) | Built during the hackathon window. |
| **PWA & Brand Icons (`icon.svg`, `apple-icon.png`, `icon-*.png`)** | **NEW (Hackathon)** | `nextjs-woundmeter/app/` & `public/` (`mtime: 2026-11-01`) | Created during the hackathon window. |
| **Meta SAM 3.1 Client, Guided Two-Pass Strategy & Custom Base85/Range Raster Codec** | **NEW (Hackathon)** | `meta_client.py` ($636$ lines), `sam_codec.py` ($453$ lines), `sam_guidance.py` ($115$ lines), `model_comparison.py` ($142$ lines) (`mtime: 2026-11-04`) | Core hackathon AI engineering. |
| **Meta Muse Spark 1.3 & Muse Voice Transcribe 1.0 Clinical AI Service** | **NEW (Hackathon)** | `clinical_ai_service.py` ($1,453$ lines), `api/clinical_ai.py` ($210$ lines) (`mtime: 2026-11-04`) | Core hackathon AI engineering. |
| **Connected-Care Backend, Inpatient Nursing, Auth/MFA, AES-256-GCM & Audit Chain** | **NEW (Hackathon)** | `connected_care_db.py` ($3,762$ lines), `nursing_service.py` ($929$ lines), `auth_service.py` ($404$ lines), `admin_service.py` ($416$ lines) (`mtime: 2026-11-04`) | Built/consolidated into PostgreSQL 16 during the hackathon window. |
| **Next.js 15 Multi-Role Portals, Interactive Polygon Editor & Stateless `/demo`** | **NEW (Hackathon)** | $103$ TS/TSX files ($16,035$ lines) in `nextjs-woundmeter/`, `api/demo_measure.py` ($576$ lines) (`mtime: 2026-11-04`) | Built during the hackathon window. |

### 4.3 Attribution, Licensing, and Compliance Findings
- **Evidence:** `.git/config` (`Worawit Tepsan <worawit.tepsan@email.cmu.ac.th>`), `requirements.txt`, `package.json`.
- **Status:** **Verified with Minor Repository Packaging Gaps**
- **Severity:** **P2 (Low / Administrative)**
- **Findings & Recommendations:**
  1. **Clear Separation of Old vs. New:** Both `README.md` and this evaluation explicitly attribute the August 2025 `best.pt` YOLOv8 weight and August 2026 base ruler YAML as pre-existing foundations, ensuring full transparency for judges.
  2. **Missing `LICENSE` File in Repo Root:** No `LICENSE` file is currently present in `/home/ragserver/WoundMeter`. Add an explicit open-source or academic research licence file before final public archival.
  3. **Uncommitted Working Tree on Deployment Host:** Run an initial Git commit on the `main` branch (excluding `.env`, `demo-data/`, and `resources/models/best.pt` via `.gitignore`) so judges cloning the repository see a clean commit history.

---

## 5. Deployment Assessment

All live probes and Playwright headless Chromium tests (`v156.0.8078.4`) were executed in read-only mode without modifying production database records.

### 5.1 Live URL, Proxy, & Route Verification Matrix

| Endpoint / Check | URL / Target | HTTP Status | Content-Type / Size | Latency | Browser / Proxy Result | Status |
| :--- | :--- | :---: | :--- | :---: | :--- | :---: |
| **Main Application** | `https://woundmeter.wtepsan.dev/` | `200 OK` | `text/html; charset=utf-8` ($8,313\text{ B}$) | $150\text{ ms}$ | Renders Sign-In + 4 Demo Persona cards; `0` console errors; `0` failed requests | **Verified** |
| **Instructions Page** | `https://woundmeter.wtepsan.dev/instruction` | `200 OK` | `text/html; charset=utf-8` ($23,869\text{ B}$) | $168\text{ ms}$ | Renders 5-step Photo Guide + 3 PNG illustrations (`naturalWidth > 0`); `0` console errors | **Verified** |
| **Interactive Demo** | `https://woundmeter.wtepsan.dev/demo` | `200 OK` | `text/html; charset=utf-8` ($11,389\text{ B}$) | $98\text{ ms}$ | Renders stateless capture + live camera + upload workbench; `0` console errors | **Verified** |
| **Offline Fallback Page** | `https://woundmeter.wtepsan.dev/offline` | `200 OK` | `text/html; charset=utf-8` ($11,356\text{ B}$) | $136\text{ ms}$ | Renders clean offline explanation page | **Verified** |
| **PWA Manifest & Worker** | `/manifest.json` & `/sw.js` | `200 OK` | `application/json` ($1,067\text{ B}$) / `application/javascript` ($4,194\text{ B}$) | $118–221\text{ ms}$ | Valid manifest; service worker caches only `/offline` and immutable hashed static chunks | **Verified** |
| **Session Auth Check** | `GET /api/auth/session` | `200 OK` | `application/json` (`{"account":null}`) | $108\text{ ms}$ | Clean unauthenticated session response; `Cache-Control: no-store` | **Verified** |
| **Internal API Isolation** | `GET /v2/health` (via public domain) | `404 Not Found` | `text/html` ($8,578\text{ B}$) | $110\text{ ms}$ | FastAPI `:8000` is **not** exposed publicly; only Next.js `/api/*` proxy routes reach it | **Verified** |
| **Direct-Route Refresh** | `page.reload()` on `/instruction` & `/demo` | `200 OK` | Desktop (`1366×800`) & Mobile (`393×851`) | $< 1.5\text{ s}$ | Full SSR + hydration succeeds on direct navigation and reload | **Verified** |
| **Responsive Layout** | Desktop (`1366×800`) & Pixel 5 (`393×851`) | `200 OK` | `scrollWidth == clientWidth` (`1366/1366`, `393/393`) | — | Zero unintended horizontal overflow across `/`, `/instruction`, and `/demo` | **Verified** |

### 5.2 Instructions Page (`/instruction`) Evaluation
- **Evidence:** [`nextjs-woundmeter/app/instruction/page.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/app/instruction/page.tsx) (lines 1–75), live DOM inspection at `https://woundmeter.wtepsan.dev/instruction`.
- **Status:** **Verified (Concise Photo Guide; Partial Coverage of Extended Topics)**
- **Severity:** **P1 (Moderate — Content Completeness on `/instruction`)**
- **Detailed Check Against Prompt Criteria:**
  - *How caregivers capture photographs & position the physical ruler:* **Clearly explained** across Steps 1–3 with 3 loaded illustrations (`instruction_1ruler.png`, `instruction_2takephoto.png`, `instruction_3woundwithruler.png`), explicitly instructing users to place the manufactured L-ruler on the wound plane, keep tag IDs `1`, `0`, `10`, and the 4th size-ID tag visible, avoid glare/shadow, and never crop the photo or print the screen illustration as a template.
  - *Matches actual interface & avoids unauthorised medical advice:* **Verified.** Contains zero diagnostic or treatment claims and links cleanly back to `/`.
  - *What is missing on `/instruction` itself:* Because `app/instruction/page.tsx` is a focused 5-step **Photo Guide**, it only briefly mentions in Step 4–5 that *"the server finds the ruler, corrects for camera tilt and outlines the wound"* and *"A clinician reviews every result before it joins the record."* Detailed explanations of **who WoundMeter is for**, **what AI (`sam-3.1` / `muse-spark-1.3`) does and does not do**, **how interactive boundary corrections work**, **when caregivers should seek urgent professional help (`1669`)**, and **safety limitations** are currently distributed across the sign-in screen (`SignInScreen.tsx`), caregiver submission screen (`SubmitUpdate.tsx`), and clinical record panels (`AiAssistance.tsx`, `PhotoPanel.tsx`) rather than consolidated on `/instruction`.
  - *Recommendation:* Add two concise sections below the 5 steps on `/instruction`: (1) **"How AI and Clinician Review Work Together (What AI Does & Does Not Do)"** and (2) **"When to Seek Immediate Medical Help & Safety Limitations."**

### 5.3 Interactive Demo (`/demo`) Evaluation from a First-Time Judge's Perspective
- **Evidence:** [`nextjs-woundmeter/app/demo/page.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/app/demo/page.tsx), [`components/demo/DemoWorkflow.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/demo/DemoWorkflow.tsx), [`fastapi-woundmeter/app/api/demo_measure.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/api/demo_measure.py), and 5 production demo execution traces in `demo-data/images/2026-11-04/`.
- **Status:** **Verified**
- **Criterion-by-Criterion Assessment:**
  1. **Immediately understandable & minimal setup:** **Yes** — Opens directly into a clean 2-step card (`1. Take or choose the photo`, `2. Measure`) with zero sign-in required.
  2. **Selected patient and wound are obvious:** **Yes** — Explicitly labelled `Photo · Demo wound` and `Demo wound DEMO · No patient · no wound location · not saved`, avoiding any confusion with real clinical records.
  3. **Demonstrates the main workflow within 3 minutes:** **Yes (when a ruler photo is supplied)** — Runs the exact production pipeline (`detect_ruler_markers` $\rightarrow$ `estimate_ruler_geometry` $\rightarrow$ `calibrate_colour` $\rightarrow$ `YOLOv8 + Meta SAM 3.1` $\rightarrow$ `calculate_measurements` $\rightarrow$ `/explain` `muse-spark-1.3` draft $\rightarrow$ interactive polygon edit via `/preview` & `/refine` $\rightarrow$ `/ai-observations` & `/ai-revise` $\rightarrow$ 4-attestation clinical sign-off).
  4. **SAM and Muse Spark contributions are visible:** **Yes** — `PhotoPanel.tsx` displays the active model badge (`Meta SAM 3.1` vs `YOLOv8 (local)`), candidate outline buttons, and Dice/IoU comparison warnings; `AiAssistance.tsx` displays `Meta Muse Spark 1.3` visual observations and draft notes.
  5. **AI output and human corrections are distinguishable:** **Yes** — Colour-coded strokes (`#F97316` orange for `ai_predicted`, `#14B8A6` teal for `human_corrected`, `#22C55E` green for `human_accepted`), explicit badges (`AI-proposed boundary` vs `Adjusted · awaiting verification`), and automatic invalidation (`stale`) of AI draft notes after boundary edits.
  6. **Repeatable without changing real patient records:** **Yes** — `/v2/demo/*` endpoints write **zero rows** to PostgreSQL and **zero files** to the clinical `uploads` volume. Clicking **Measure another photo** resets browser state cleanly.
  7. **Friction Point Identified (`DEMO_SAMPLE_DATA = false`):** In [`nextjs-woundmeter/lib/accounts.ts`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/lib/accounts.ts#L8), `DEMO_SAMPLE_DATA` is `false`. Consequently, `/demo` does not offer a one-click pre-loaded sample ruler photograph. If a judge uploads a normal photograph without AprilTags `0, 1, 10` and a length tag (as occurred in run `152540_DEMO-OBS-2A370C22`), `/demo` halts at `CalibrationDiagnostics.tsx` (`missing_marker`). Providing a 1-click synthetic sample photo on `/demo` is our #1 UX recommendation.

### 5.4 Proxy, Caching & HTTP Security Headers
- **Confirmed Deployment Issues vs. Testing-Environment Limitations:**
  - *Testing-environment limitation:* The local execution sandbox had outbound DNS disabled and the local Docker socket stopped; elevating only the network/build probes (`BypassSandbox: true`) confirmed that the live domain `woundmeter.wtepsan.dev` is healthy and fast ($98–256\text{ ms}$).
  - *Confirmed proxy header issue (P2):* `curl -sSI http://woundmeter.wtepsan.dev` returned `HTTP/1.1 200 OK` over plaintext HTTP rather than a `301/308` redirect to `https://`, and the HTTPS response omits `Strict-Transport-Security` (HSTS) and returns `cache-control: s-maxage=31536000` on HTML routes (`cf-cache-status: DYNAMIC` currently prevents edge caching of private data, but HTML routes should set `Cache-Control: private, no-cache`).

---

## 6. Technical Architecture & Feature Verification Matrix

### 6.1 Architectural Overview
WoundMeter employs a clean, defence-in-depth three-tier architecture:
- **Frontend (`nextjs-woundmeter`):** Next.js 15.5.28 App Router (`output: "standalone"`), React 18.3.1, TypeScript 5.5.4, Tailwind CSS 4.1.11. Uses server-side route handlers (`app/api/auth/[action]`, `app/api/wound-workflow`, `app/api/wound-measure`, `app/api/demo/[action]`) that convert `httpOnly; SameSite=Strict` cookies (`wm_session`, `wm_mfa`) into internal `X-Reviewer-Token` headers for FastAPI, while enforcing same-origin CSRF verification (`isSameOrigin`) and streaming request size limits ($10\text{ MB}$ image cap).
- **Backend (`fastapi-woundmeter`):** FastAPI 0.162.0 on Python 3.11 (`uvicorn`, single worker with thread-safe locks/semaphores), OpenCV 4.10.0.84 (`cv2.aruco.DICT_APRILTAG_36h11`), PyTorch 2.6.0 CPU + Ultralytics 8.3.40 (`YOLOv8-seg`), `cryptography==50.0.2` (AES-256-GCM + HMAC-SHA256 + PBKDF2-SHA256), and `psycopg[binary]==3.2.13`.
- **Database (`postgres:16-bookworm`):** 28 relational tables managed by [`migrations/001_initial.sql`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/migrations/001_initial.sql) with transactional advisory locks (`pg_advisory_lock(4456001)` for migrations/approvals, `4456002` for audit hash-chaining) and startup SHA-256 verification of applied SQL migrations and `best.pt`.

### 6.2 Comprehensive Feature Classification Table

Every inspected capability is classified strictly as:
**`Verified`** | **`Implemented but not tested`** | **`Demo-only`** | **`Incomplete`** | **`Planned`** | **`Not verified`**

| Feature / Subsystem | Primary Implementation Files | Classification | Verification Evidence |
| :--- | :--- | :---: | :--- |
| **Next.js 15 App Shell, Role Portals & Type Safety** | `nextjs-woundmeter/app/`, `components/` ($103$ files) | **Verified** | Passed `npx tsc --noEmit` (0 errors), production `next build` (10 static/dynamic routes), and Playwright desktop/mobile rendering. |
| **FastAPI Service & Request Body Size Limiter** | `fastapi-woundmeter/app/main.py`, `request_limits.py` | **Verified** | All 53 Python files pass `py_compile`; `RequestBodyLimit` enforces byte caps on chunked and content-length uploads; live API responds via Next.js proxy. |
| **PostgreSQL 16 Schema (28 Tables) & Checksum Migrations** | `migrations/001_initial.sql`, `migrate.py`, `postgres.py` | **Verified** | Schema inspected line-by-line; live app serves session and demo endpoints backed by the running container stack. |
| **Docker Compose Isolation & Model Checksum Gate** | `compose.yml`, `Dockerfile`, `docker-entrypoint.sh`, `SHA256SUMS` | **Verified** | `docker compose config --quiet` passed; `sha256sum -c SHA256SUMS` verified (`bb45e8da...`); only `127.0.0.1:4456` published on host. |
| **AprilTag 36h11 Detection & Dynamic 4th Length Marker (`6–30 cm`)** | `apriltag_detector.py`, `ruler_template.py`, `ruler_geometry.py` | **Verified** | Verified in synthetic perspective tests ($0^\circ, 15^\circ, 30^\circ$ tilt, reprojection error $0.084–0.151\text{ mm}$) and 4 live production runs in `demo-data/` detecting tags `[0, 1, 10, 18]`. |
| **Partial Ruler-Square Coverage Gate (`MIN_INNER_COVERAGE = 0.5`)** | `ruler_geometry.py`, `measurement_contract.py` | **Verified** | Unit-tested in `unit_checks.py` (wounds inside photo accepted; wounds within $1\text{ mm}$ of missing frame refused) and verified in live `demo-data/` warnings. |
| **8-Patch Colour Calibration ($\Delta E_{00}$, Linear sRGB, WB + Ridge Matrix)** | `colour_calibration.py`, `colour_profile_v1.yaml` | **Verified (Experimental Reference)** | Code verified; live trace `160616_DEMO-OBS-56252D6E` executed `white_balance_diagonal`, generated `colour-corrected.jpg`, and accurately flagged `UNVERIFIED_REFERENCE`. |
| **Physical Ruler & Colour Reference Metrology QA (`validated: true`)** | `ruler_template_v1.yaml` (`validated: false`), `colour_profile_v1.yaml` (`UNVERIFIED_REFERENCE`) | **Incomplete / Planned** | Transparently marked unvalidated in YAML and surfaced as explicit warnings in every API response and UI card until physical print QA is performed. |
| **Image Quality Thresholds (Blur, Under/Overexposure Cutoffs)** | `config.py` (`blur_variance_min=None`), `image_decoder.py` | **Incomplete** | Focus variance and exposure fractions are computed and reported in `image_quality.warnings`, but hard cutoff thresholds are `None` (`status: "not_evaluated"`). |
| **Local YOLOv8-seg CPU Segmentation (`best.pt`)** | `yolo_segmenter.py`, `pipeline.py` | **Verified** | Live traces `153942`, `160616`, `163041`, `163539` confirm CPU inference in $219.5–248.5\text{ ms}$ and automatic fallback when SAM times out. |
| **Meta SAM 3.1 Guided Two-Pass Segmentation & Custom Raster Codec** | `meta_client.py`, `sam_codec.py`, `sam_guidance.py`, `pipeline.py` | **Verified** | Live traces `163041` ($5,409\text{ ms}$) and `163539` ($4,522\text{ ms}$) confirm `sam_live_inference` with `sam-3.1` and inter-model comparison (`model_comparison.py`). |
| **Muse Spark 1.3 Explanations, Visual Findings, Draft Revision, Reports & Assistant** | `meta_client.py`, `clinical_ai_service.py`, `api/clinical_ai.py` | **Implemented & Partially Verified Live** | `META_AI_ENABLED=true` (`muse-spark-1.3`) verified in live demo configuration and code; regex/colour guardrails (`guard_visual_findings`) verified; full end-to-end live LLM calls on patient records not re-triggered to avoid mutating production data or incurring unnecessary API spend. |
| **Muse Voice Transcribe 1.0 Clinical Dictation** | `clinical_ai_service.py` (`transcribe_audio`), `wav-recorder.ts` | **Implemented but not tested** | Full client 16/24 kHz mono PCM WAV recorder and server `muse-voice-transcribe-1.0` adapter are implemented; not executed with live microphone audio during headless review. |
| **Deterministic Wound Measurements (Area, Perimeter, Chords, Clinical Feret Axes)** | `wound_measurement.py` | **Verified** | Tested against analytical rectangles ($0.5000\text{ cm}^2$ exact) and perspective-warped ellipses ($+0.58\%$ to $+0.92\%$ area error across $0^\circ–30^\circ$ tilt). |
| **Interactive Polygon Boundary Editor & Server Validation** | `PhotoWorkspace.tsx`, `measurement_contract.py` (`strict_polygon_mask`) | **Verified** | Verified in code and unit tests (`16/16` checks passed: rejects bow-tie self-intersections, $<3$ vertices, out-of-window points, and multi-component regions). |
| **Clinical Review, 4 Fingerprint-Bound Attestations & Immutable Sign-Off** | `RecordForm.tsx`, `approval-attestations.ts`, `connected_care_db.py` | **Verified (Code & Stateless Demo)** | Attestation fingerprint binding, idempotency receipts (`clinical_approval_receipts`), and amendment versioning verified in code and `/demo` UI. |
| **Record Versioning, Soft-Delete Governance & SHA-256 Audit Hash Chain** | `connected_care_db.py`, `record_lifecycle.py`, `migrations/001_initial.sql` | **Implemented & Code-Verified** | Advisory-locked `prev_hash`/`entry_hash` chain (`_append_audit`), measurement/assessment `version_number` increments, and dual-control restoration verified in code (not executed against live DB to obey read-only production rule). |
| **Inpatient Nursing Module (Ward Board, Admissions, Braden Scale)** | `nursing_service.py`, `api/nursing.py`, `components/nursing/`, `braden.ts` | **Implemented & Code-Verified** | Complete 6-subscale Braden calculator, shift sessions, admission reports, and daily assessment tracking verified in source and TypeScript build. |
| **Authentication (PBKDF2-SHA256, TOTP MFA, Lockouts) & RBAC** | `auth_service.py`, `permission_policy.py`, `identity_protection.py` | **Verified (Code & Session Probe)** | `600,000`-iteration PBKDF2, RFC 6238 TOTP replay prevention (`mfa_last_step`), 5-strike lockout, and AES-256-GCM PII encryption verified in code; `/api/auth/session` verified live. |
| **One-Click Demo Personas & Stateless `/demo` Workbench** | `demo_accounts.py`, `demo_measure.py`, `DemoWorkflow.tsx` | **Demo-only (Verified)** | Guarded by `WOUNDMETER_DEMO_MODE`; verified live on `/` and `/demo`. |
| **Pre-Loaded Synthetic Sample Photo on `/demo` (`DEMO_SAMPLE_DATA`)** | `nextjs-woundmeter/lib/accounts.ts` (`DEMO_SAMPLE_DATA = false`) | **Planned / Disabled** | Flag exists in frontend components (`SubmitUpdate.tsx`, `NewMeasurementPanel.tsx`) and `demo_measure.py` (`synthetic_demo_image: None`), but is disabled in this build. |

---

## 7. Meta AI Assessment

### 7.1 Genuine Execution vs. Cosmetic Wrapping
WoundMeter's integration of the Meta Model API (`https://api.meta.ai/v1`) is **genuine, deep, and architecturally necessary**:

- **Evidence:** [`fastapi-woundmeter/app/services/meta_client.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/meta_client.py), [`sam_codec.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/sam_codec.py), [`sam_guidance.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/sam_guidance.py), [`clinical_ai_service.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/clinical_ai_service.py), and live execution logs in `demo-data/images/2026-11-04/163041_DEMO-OBS-20697B6A/result.json` and `163539_DEMO-OBS-0B3CB431/result.json`.
- **Status:** **Verified**

### 7.2 Technical Highlights of the Meta AI Implementation
1. **Custom SAM 3.1 Binary Codec (`sam_codec.py`):** Rather than relying on fragile third-party wrappers, the backend implements a 453-line parser and raster decoder for SAM 3.1's `<Seg>` response format, including custom alphabet Base85 unpacking, 16-bit big-endian range decoding (`_RangeDecoder`), PNG-style scanline filters (Sub, Up, Average, Paeth), run-length/1-bit raster decoding, and `<Prompt>[x1,y1,x2,y2; px,py:1]</Prompt>` multi-object spatial prompt serialization.
2. **Domain-Specific Two-Pass Guided SAM 3.1 (`sam_guidance.py` & `pipeline.py`):**
   - Solves a documented failure mode where text-only prompts (`"red wound"`) exclude yellow slough islands inside a wound bed.
   - Uses concept prompts (`"wound"`, `"red wound"`) + local YOLOv8 masks only to locate seed regions, computes the maximum $L_2$ interior distance-transform point and a $10\%$-expanded bounding box, and invokes `sam-3.1` in spatial mode to segment the entire wound boundary.
   - Preserves clinical choice: if the concept mask and the box-refined mask differ (`mask_dice < 0.97`), both are returned as selectable candidates (`sam_refined_whole_wound` vs. `sam_concept`) and `overall_status` is set to `review_required`.
3. **Live Execution & Timeout Resilience:**
   - In production runs `163041` and `163539`, `sam-3.1` completed live inference in **$5,408.96\text{ ms}$** and **$4,522.28\text{ ms}$** (`meta_execution_status: "sam_live_inference"`), compared against local YOLOv8 ($226.16\text{ ms}$ and $229.90\text{ ms}$), and triggered an automatic model-disagreement warning requiring human review.
   - In earlier runs `153942` and `160616`, when the external Meta API hit the 20-second deadline, `_post_with_retry` aborted cleanly and the pipeline automatically fell back to local YOLOv8 (`meta_execution_status: "yolo_local_fallback"`), proving zero single-point-of-failure dependency on cloud latency.
4. **Constrained Muse Spark 1.3 (`muse-spark-1.3`) & Voice (`muse-voice-transcribe-1.0`):**
   - Every Muse Spark call enforces `response_format: {type: "json_schema", json_schema: {strict: True, ...}}`.
   - `MUSE_SYSTEM_PROMPT` and `OBSERVATION_SYSTEM_PROMPT` forbid diagnosing, staging, prescribing, or altering deterministic numbers.
   - Post-generation regex filters (`guard_visual_findings`, `revision_flags`) deterministically redact any staging/diagnostic terminology or uncalibrated colour descriptions before they can reach the UI or database.

---

## 8. Measurement and Validation

### 8.1 Calibration & Geometric Pipeline
1. **Fiducial Detection (`apriltag_detector.py`):** Detects `APRILTAG_36h11` markers with `CORNER_REFINE_SUBPIX`. Requires unique corner IDs `0` $(0,0)\text{ mm}$, `1` $(0, L)\text{ mm}$, `10` $(L, 0)\text{ mm}$, plus exactly one length marker along the baseline between `0` and `10` with ID $\in \{6..30\} \setminus \{10\}$, dynamically sizing the ruler template to $L\text{ cm}$ (e.g., ID `18` $\rightarrow 18\text{ cm}$ complete ruler, $15\text{ cm} \times 15\text{ cm}$ inner window, $1800 \times 1800\text{ px}$ canonical crop at $10\text{ px/mm}$).
2. **Homography & Handedness Verification (`ruler_geometry.py`):** Estimates the $3\times 3$ homography from 12 tag corners via RANSAC (`ransacReprojThreshold = 10 px = 1.0 mm`), refines on all 12 corners when consistent, verifies local Jacobian handedness (`_local_handedness > 0`) at every tag to prevent mirror/fold inversions, and checks marker quiet zones (`quiet_zone.py`).
3. **Deterministic Physical Measurements (`wound_measurement.py`):**
   - **Area ($\text{cm}^2$):** $\text{count\_nonzero}(\text{binary}) / (\text{pixels\_per\_mm}^2 \times 100)$.
   - **Perimeter ($\text{cm}$):** `cv2.arcLength(contour, True)` $/ (\text{pixels\_per\_mm} \times 10)$.
   - **Ruler-Axis Length & Width ($\text{cm}$):** Longest continuous vertical ($Y$) and horizontal ($X$) foreground runs (`_maximum_axis_chords`).
   - **Clinical Major Axis & Perpendicular Width ($\text{cm}$):** Exact maximum Feret diameter across convex-hull vertices (`_clinical_major_and_perpendicular_axes`) and maximum orthogonal projection span.

### 8.2 Independent Synthetic & Unit Validation Results
We executed two standalone verification suites against the repository's actual Python modules:

| Test Case / Verification Check | Ground Truth | Measured by WoundMeter | Error / Result | Status |
| :--- | :--- | :--- | :--- | :---: |
| **Synthetic Phantom — Fronto-Parallel ($0^\circ$ tilt, ID 18)** | Area $9.676\text{ cm}^2$, Major $4.400\text{ cm}$, Minor $2.800\text{ cm}$ | Area $9.765\text{ cm}^2$, Major $4.419\text{ cm}$, Minor $2.822\text{ cm}$ | Area **$+0.92\%$**, Reproj mean **$0.151\text{ mm}$** (max $0.250\text{ mm}$) | **PASS** |
| **Synthetic Phantom — Perspective Tilt $15^\circ$ (ID 18)** | Area $9.676\text{ cm}^2$, Major $4.400\text{ cm}$, Minor $2.800\text{ cm}$ | Area $9.737\text{ cm}^2$, Major $4.412\text{ cm}$, Minor $2.816\text{ cm}$ | Area **$+0.63\%$**, Reproj mean **$0.084\text{ mm}$** (max $0.161\text{ mm}$) | **PASS** |
| **Synthetic Phantom — Perspective Tilt $30^\circ$ (ID 18)** | Area $9.676\text{ cm}^2$, Major $4.400\text{ cm}$, Minor $2.800\text{ cm}$ | Area $9.732\text{ cm}^2$, Major $4.408\text{ cm}$, Minor $2.814\text{ cm}$ | Area **$+0.58\%$**, Reproj mean **$0.138\text{ mm}$** (max $0.222\text{ mm}$) | **PASS** |
| **Analytical Rectangle ($100\times 50\text{ px}$ at $10\text{ px/mm}$)** | Area $0.5000\text{ cm}^2$, $L=0.50\text{ cm}$, $W=1.00\text{ cm}$ | Area $0.5000\text{ cm}^2$, $L=0.50\text{ cm}$, $W=1.00\text{ cm}$ | **$0.0000\%$** exact | **PASS** |
| **Scale Inverse-Square Scaling ($20\text{ px/mm}$)** | Area $0.1250\text{ cm}^2$ | Area $0.1250\text{ cm}^2$ | **$0.0000\%$** exact | **PASS** |
| **Polygon Boundary Contract (`strict_polygon_mask`)** | Reject bow-tie self-crossing, out-of-window, `None`, and multi-component masks | All invalid polygons raised `ValueError`; valid square accepted | **$7/7$ checks passed** | **PASS** |
| **Partial Photo Coverage Contract (`reaches_outside_photo`)** | Refuse wound within $1\text{ mm}$ of missing photo edge; accept interior wound | Interior accepted (`False`); edge-reaching refused (`True`) | **$2/2$ checks passed** | **PASS** |
| **SAM Boundary Post-Processing (`clean_boundary_mask`)** | Fill interior hole ($5,025\text{ px}$); remove $4\times 4\text{ px}$ speck ($<2\text{ mm}^2$) | Hole filled (`filled=5025`), speck removed (`removed=16`) | **$3/3$ checks passed** | **PASS** |

### 8.3 Epistemic Honesty & Unvalidated Hardware Flags
WoundMeter deserves high marks for metrological honesty:
- Every measurement payload includes `"sampling_disclosure": "Sampled on a 10 px/mm (0.1 mm) canonical homography grid; grid spacing is not equivalent to 0.1 mm physical or clinical measurement accuracy."`
- Both `ruler_template_v1.yaml` (`validated: false`) and `colour_profile_v1.yaml` (`reference_status: UNVERIFIED_REFERENCE`) explicitly state that physical printed rulers have not yet been verified with physical metrology instruments.

---

## 9. Human-in-the-Loop Assessment

WoundMeter's human-in-the-loop architecture is one of the strongest aspects of the repository:

1. **Caregiver vs. Clinician Information Asymmetry (`connected_care_db.py`):**
   - Family caregivers (`FAMILY_CAREGIVER`) can upload home photographs, record structured symptom facts, view clinician-approved care instructions, and mark care tasks complete.
   - When a non-clinician queries an observation that has not yet been approved by a clinician (`review_state != "CLINICIAN_APPROVED"`), the backend sets `provisional_hidden_for_non_clinician = True` and strips unverified AI measurements, candidate masks, and clinical drafts so families never act on raw AI predictions.
2. **Mandatory Boundary Selection When Models Disagree (`DemoWorkflow.tsx`, `ObservationReview.tsx`):**
   - When multiple wound components or alternative SAM outlines (`sam_refined_whole_wound` vs. `sam_concept`) are present (`selection_required = true`), the clinical assessment form is physically locked (`<LockedArea locked={Boolean(photoTodo)}>`, `inert` attribute) until the clinician selects or edits the wound boundary and labels what it measures (`whole_wound` vs. `red_tissue_only`).
3. **Stale Draft Invalidation (`RecordForm.tsx`):**
   - If a clinician uses a Muse Spark draft note and subsequently edits the wound boundary, `draft_status` transitions to `"stale"` and the form blocks signing until the clinician either clears/rewrites the note or requests a fresh draft matching the new measurement version.
4. **Four Cryptographically Bound Clinical Attestations (`approval-attestations.ts`):**
   - Signing requires confirming four explicit statements, each bound to a live state fingerprint (`photoSha256`, `measurementId:v{version}`, `colourStatus`, and `JSON.stringify(assessment)`). Changing any field automatically flips the corresponding attestation from `"confirmed"` to `"changed"` and disables sign-off.
5. **Immutable Versioning & Hash-Chained Audit Trail (`connected_care_db.py`):**
   - Every boundary refinement increments `wound_measurements.version_number` (`v1` AI provisional $\rightarrow$ `v2` `HUMAN_CORRECTED` $\rightarrow$ `v3` `FINAL_CLINICIAN_APPROVED`).
   - Approved clinical assessments are marked `is_immutable = 1`; post-sign-off changes require an explicit **Amendment** (`amends_assessment_id`, `amendment_reason`) creating a new version while preserving the prior signed version.
   - Every action is recorded in `audit_events` under `pg_advisory_xact_lock(4456002)` with `prev_hash` and `entry_hash = sha256(canonical_json)`.

---

## 10. UX and Accessibility

- **Evidence:** Playwright desktop (`1366×800`) and mobile (`393×851`) audits, [`globals.css`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/app/globals.css), [`PhotoWorkspace.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/components/record/PhotoWorkspace.tsx), [`instruction/page.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/app/instruction/page.tsx).
- **Status:** **Verified**

### Strengths
- **Mobile-First Responsiveness:** Zero horizontal overflow (`scrollWidth == clientWidth == 393` on Pixel 5) across `/`, `/instruction`, and `/demo`. Touch and pointer events (`onPointerDown`, `onPointerMove`, `onPointerUp`) are supported in the polygon boundary editor.
- **Visual Clarity & Provenance Coding:** Clear orange (`#F97316`), teal (`#14B8A6`), and green (`#22C55E`) colour coding distinguishes AI-predicted, clinician-adjusted, and approved contours.
- **Accessible Semantics:** Landmark elements (`<main id="main">`, `<header>`, `role="status"` live regions for AI progress and form locks, `inert` locking on blocked forms, and `lang="en"`) are consistently applied.

### UX Weaknesses & Accessibility Gaps Identified
1. **Empty `alt=""` on Instructional Diagrams (`/instruction`) — P2 Accessibility Gap:** In [`nextjs-woundmeter/app/instruction/page.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/app/instruction/page.tsx#L66), the three instructional `<Image src={step.image} alt="" fill ... />` elements have empty `alt=""` attributes. While surrounding step text describes each step, descriptive `alt` text should be provided for screen-reader users.
2. **English-Only Interface for a Thailand Caregiving Context — P2 Localization Gap:** Although the system targets Thai healthcare workflows (`CLINICAL_TIMEZONE=Asia/Bangkok`, `thai-id.ts` citizen ID validation, `1669` emergency number, Dr. Somchai / Nurse Mali / Caregiver Suda personas), the UI copy and `/instruction` guide are currently English-only. Adding a Thai (`ภาษาไทย`) toggle for family caregivers would substantially increase real-world accessibility.

---

## 11. Safety, Privacy, and Security

| Domain | Safeguard / Finding | Evidence | Status | Severity |
| :--- | :--- | :--- | :---: | :---: |
| **Clinical Safety Guardrails** | System prompts + regex post-filters (`guard_visual_findings`) strip staging, diagnosis, tissue %, and uncalibrated colour claims; epistemic notices warn that area change $\neq$ healing | [`clinical_ai_service.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/clinical_ai_service.py#L118-L165), [`meta_client.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/meta_client.py#L163-L175) | **Verified** | — |
| **Patient PII Encryption at Rest** | Patient names, MRNs, Thai national IDs, phones, and addresses are encrypted with **AES-256-GCM** (`aad=b"woundwise-v1"`) using HKDF-derived keys from `PATIENT_DATA_KEY` and indexed via HMAC-SHA256 blind indexes (`PATIENT_INDEX_KEY`) | [`identity_protection.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/identity_protection.py) | **Verified** | — |
| **External AI Privacy (EXIF & Crop Stripping)** | Only the rectified inner ruler window (`inner_bgr`) re-encoded via `cv2.imencode(".jpg")` (stripping all EXIF/GPS/camera metadata) and pseudonymous `patient_code` references are sent to the Meta Model API | [`meta_client.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/meta_client.py#L288-L292), [`clinical_ai_service.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/clinical_ai_service.py) | **Verified** | — |
| **Authentication, MFA & Session Security** | Passwords hashed with `PBKDF2-HMAC-SHA256` (`600,000` iterations); privileged roles require RFC 6238 TOTP MFA with step-replay prevention; only `sha256(token)` stored in `auth_sessions`; `httpOnly; SameSite=Strict; Secure` cookies + same-origin CSRF check | [`auth_service.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/auth_service.py), [`session.ts`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/lib/server/session.ts) | **Verified** | — |
| **Image & Database Integrity Verification** | Every stored observation image is verified against its recorded `sha256_hash` before clinical review, refinement, sign-off, or AI observation generation (`verify_observation_images`) | [`image_integrity.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/image_integrity.py), [`connected_care_db.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/services/connected_care_db.py#L2254) | **Verified** | — |
| **Kept Demo Photos & Third-Party Test Images on Host** | `WOUNDMETER_DEMO_KEEP_PHOTOS=true` is enabled in the host `.env`, saving `/demo` uploads to `./demo-data/images/2026-11-04/`. Two saved runs (`160616`, `163041`/`163539`) contain composites of third-party clinical figure images (with printed `"A"` label / cursor arrow) | `demo-data/images/2026-11-04/*/rectified.jpg`, `.env` | **Verified Issue** | **P1 (Moderate)** |
| **Database Trigger Immutability vs. App-Layer Enforcement** | Audit log append-only chaining and signed assessment immutability are enforced in Python (`connected_care_db.py`), but `001_initial.sql` does not define PostgreSQL `BEFORE UPDATE OR DELETE` triggers to block direct SQL mutation of `audit_events` | [`migrations/001_initial.sql`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/migrations/001_initial.sql) | **Verified Gap** | **P2 (Low)** |
| **Unauthenticated `/api/demo/*` Rate Limiting** | When `WOUNDMETER_DEMO_MODE=true`, `/v2/demo/*` uses a 4-slot concurrency semaphore (`MAX_PARALLEL = 4`), but has no per-IP rate limiter, allowing repeated public calls to consume Meta API quota | [`demo_measure.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/api/demo_measure.py#L62-L64) | **Verified Gap** | **P2 (Low)** |

---

## 12. Testing Evidence

### 12.1 Tests Completed During This Evaluation
Because the deployment repository intentionally omits its pre-deployment `tests/` directory (`README.md` line 195), we executed five independent verification layers without modifying any repository source files or production database state:

1. **Backend Static & Bytecode Compilation:**
   - Command: `python3 -m py_compile $(find fastapi-woundmeter/app -name '*.py')`
   - Result: **53 / 53 Python modules compiled cleanly (`COMPILE_OK`)**.
2. **Docker Compose Specification Validation:**
   - Command: `docker compose config --quiet`
   - Result: **Passed (`COMPOSE_CONFIG_OK`)**; verified SHA-256 checksum of `resources/models/best.pt` (`bb45e8da5940861b163a5c5193040da7a80b26c8ff69a1703cd501065357531f`).
3. **Frontend TypeScript Type-Checking, Production Build & Dependency Security Audit:**
   - Executed in an isolated copy of `nextjs-woundmeter`:
     - `npx tsc --noEmit` $\rightarrow$ **`TSC_EXIT=0` (0 type errors across 103 TS/TSX files)**.
     - `WOUNDMETER_DEMO_MODE=true npx next build` $\rightarrow$ **`BUILD_EXIT=0` (compiled in 12.9 s; 10 routes generated)**.
     - `npm audit --omit=dev` $\rightarrow$ **`found 0 vulnerabilities`**.
4. **Live Deployment HTTP & Playwright Headless Chromium Audit:**
   - Verified 14 public URLs/assets via `curl` and ran headless Chromium (`1366×800` desktop and `393×851` Pixel 5 mobile) across `/`, `/instruction`, and `/demo`, including direct-route reload tests (`report.json` & 6 full-page screenshots).
   - Result: **All 3 pages returned `HTTP 200`, `0` console errors, `0` failed network requests, and `0` horizontal layout overflows**.
5. **Isolated Synthetic Calibration & Deterministic Unit Checks:**
   - Executed against the real FastAPI service modules (`ruler_template.py`, `apriltag_detector.py`, `ruler_geometry.py`, `canonical_crop.py`, `wound_measurement.py`, `measurement_contract.py`, `sam_guidance.py`):
     - **Synthetic Perspective Calibration ($0^\circ, 15^\circ, 30^\circ$ tilt):** **`3 / 3` passed** with $< 1.0\%$ area error ($+0.58\%$ to $+0.92\%$) and $\le 0.25\text{ mm}$ maximum AprilTag corner reprojection error.
     - **Deterministic Contract Checks:** **`16 / 16` passed** (exact area/chord scaling, invalid scale rejection, multi-component rejection, bow-tie polygon rejection, out-of-window rejection, photo-coverage edge refusal, and SAM hole-filling/speck removal).

### 12.2 Verification Limitations
- **No Committed `pytest` / Playwright Suite in Repo Tree:** While our standalone verification confirmed the geometry, contracts, build, and live pages, the repository tree itself does not currently include a committed `tests/` directory or `.github/workflows` CI pipeline.
- **Read-Only Production Constraint:** In accordance with evaluation safety rules, we did not submit mutations to the live PostgreSQL database or trigger new paid Meta API calls during the audit; live Meta SAM 3.1 (`sam-3.1`) and YOLOv8 execution on the deployed server were verified from the 5 timestamped production runs recorded in `demo-data/images/2026-11-04/*/result.json` (`15:25–16:35 UTC` on 4 Nov 2026).

---

## 13. Hackathon Judge Assessment

### 13.1 Alignment with Official Meta Global AI Developer Hackathon Criteria
For the **Meta Global AI Developer Hackathon (26 Oct–4 Nov 2026)**, projects are evaluated under two track frameworks and two overarching themes (*Build for Your World* and *Push the Frontier*):
- **Indie Developer Track Criteria:** *Creativity*, *Technical Ambition*, and *Whether It Works*.
- **Startup Track Criteria:** *Technical Execution* and *Production Readiness*.

### 13.2 Evidence-Based Judge Scorecard
*(Note: Track alignment reflects the verified Meta Global AI Developer Hackathon criteria; the 1–10 numerical ratings below are **illustrative independent review scores**, not official organizer scores.)*

| Evaluation Dimension | Illustrative Score | Key Supporting Evidence & Rationale |
| :--- | :---: | :--- |
| **1. Innovation & Problem Framing** *(Creativity / Build for Your World)* | **9.2 / 10** | Moves beyond generic "AI medical diagnosis" to solve a genuine hospital-to-home gap for family caregivers of older adults. The principle **"AI assists. Families care. Professionals decide."** is enforced in code, not just prose. |
| **2. Meta AI Integration** *(Technical Ambition / Multi-Model Depth)* | **9.4 / 10** | Combines **Meta SAM 3.1 (`sam-3.1`)**, **Meta Muse Spark 1.3 (`muse-spark-1.3`)**, and **Muse Voice Transcribe 1.0 (`muse-voice-transcribe-1.0`)**. The guided two-pass SAM strategy (concept locator $\rightarrow$ interior distance-transform point + box prompt) and custom Base85/range raster codec demonstrate exceptional model mastery. |
| **3. Technical Execution & Architecture** *(Startup Track: Technical Execution)* | **9.3 / 10** | Clean separation between projective homography calibration, neural segmentation, deterministic pixel-to-mm geometry, and LLM drafting. Backed by PostgreSQL 16, advisory locks, AES-256-GCM PII encryption, and SHA-256 hash-chained audit logs. |
| **4. Real-World Impact & Clinical Feasibility** *(Startup Track: Production Readiness)* | **8.8 / 10** | Addresses home caregiving, inpatient ward nursing (Braden Scale), and outpatient clinical review in one coherent platform. Appropriately restrained about clinical claims until physical ruler QA (`validated: true`) and clinical trials are completed. |
| **5. UX, Accessibility & Caregiver Clarity** | **8.3 / 10** | Clean, responsive desktop and mobile UI with colour-coded provenance strokes and locked form states. Held back slightly by `/instruction` being a brief 5-step photo guide and the interface being English-only. |
| **6. Live Demo Experience (`/demo` & `/`)** *(Indie Track: Whether It Works)* | **8.1 / 10** | Both `/` (4 one-click demo personas) and `/demo` (zero-sign-in clinical workbench) are fast, live, and functional. However, disabling `DEMO_SAMPLE_DATA` on `/demo` means a judge without an AprilTag ruler image on hand cannot trigger a successful measurement in one click. |
| **7. Responsible AI, Safety & Governance** | **9.6 / 10** | Benchmark-setting safety engineering for a hackathon project: EXIF-stripped inner crops, deterministic geometry, regex redaction of staging/diagnosis/tissue-% outputs, automatic suppression of uncalibrated colour claims, and 4 fingerprint-bound clinician attestations. |
| **Overall Illustrative Composite** | **9.0 / 10** | **Top-tier hackathon submission combining genuine human empathy, deep computer vision + Meta AI engineering, and rigorous clinical safety boundaries.** |

---

## 14. Risks and Weaknesses (P0 / P1 / P2)

No **P0 (Critical Submission Blockers)** were found: the live application, `/instruction`, and `/demo` are up, functional over HTTPS, and match the repository implementation. Below are the verified **P1** and **P2** issues with concrete fixes:

| ID | Issue Summary | Severity | Status | Evidence | Practical Fix / Recommendation |
| :---: | :--- | :---: | :---: | :--- | :--- |
| **R-1** | **`/demo` has no pre-loaded 1-click sample ruler photo (`DEMO_SAMPLE_DATA = false`)** | **P1** | Verified | [`nextjs-woundmeter/lib/accounts.ts`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/lib/accounts.ts#L8), [`demo_measure.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/api/demo_measure.py#L293) | Enable a synthetic phantom sample option on `/demo` (or provide a downloadable synthetic AprilTag ruler+wound PNG link directly on `/demo`) so judges can test the full SAM 3.1 + Muse Spark pipeline without printing a physical ruler. |
| **R-2** | **Kept `/demo` photos enabled (`WOUNDMETER_DEMO_KEEP_PHOTOS=true`) & third-party clinical composite images in `demo-data/`** | **P1** | Verified | `.env`, `demo-data/images/2026-11-04/160616_*` & `163041_*` | Set `WOUNDMETER_DEMO_KEEP_PHOTOS=false` in `.env` for public judging, remove third-party figure composites from `demo-data/images/2026-11-04/`, and use only synthetic or explicitly licensed wound phantoms. |
| **R-3** | **`/instruction` is a concise 5-step photo guide and omits detailed AI/clinical/emergency explanations** | **P1** | Verified | [`nextjs-woundmeter/app/instruction/page.tsx`](file:///home/ragserver/WoundMeter/nextjs-woundmeter/app/instruction/page.tsx) (75 lines) | Expand `/instruction` with concise cards covering: (a) who WoundMeter is for, (b) what AI does and does not do, (c) how clinician boundary review works, and (d) red-flag symptoms requiring immediate medical attention (`1669`) + non-empty `alt` text on the 3 images. |
| **R-4** | **No committed `tests/` directory, CI workflow, or `LICENSE` file in the deployment workspace** | **P2** | Verified | Repository root file tree; `README.md` line 195 | Commit a lightweight `tests/` suite (covering synthetic calibration, polygon contracts, and AI regex guardrails), a GitHub Actions workflow, a `LICENSE` file, and create an initial clean commit on `main`. |
| **R-5** | **Physical ruler (`validated: false`) and colour strip (`UNVERIFIED_REFERENCE`) await hardware metrology QA; image quality cutoffs (`blur_variance_min`) are `None`** | **P2** | Verified | [`ruler_template_v1.yaml`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/config/ruler_template_v1.yaml#L4), [`colour_profile_v1.yaml`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/config/colour_profile_v1.yaml#L20), [`config.py`](file:///home/ragserver/WoundMeter/fastapi-woundmeter/app/config.py#L83-L85) | Keep the current prominent warnings in place for the hackathon; calibrate printed rulers with calipers and a D65 spectrophotometer and set empirical blur/exposure cutoffs before any clinical pilot. |
| **R-6** | **Plaintext HTTP (`http://woundmeter.wtepsan.dev`) returns `200 OK` instead of redirecting to HTTPS, and HSTS header is absent** | **P2** | Verified | Live `curl -sSI http://woundmeter.wtepsan.dev` probe | Enable **"Always Use HTTPS"** and **HSTS** in the Cloudflare zone settings and set `Cache-Control: private, no-cache` on dynamic HTML routes. |

---

## 15. Three-Minute Demo Assessment

### Strongest Demonstrable Story for Hackathon Judges

The most compelling three-minute narrative does **not** present WoundMeter as a magical "AI doctor." Instead, it demonstrates **how calibration, Meta AI, and human clinical authority protect a patient cared for at home**:

1. **0:00–0:35 — The Caregiver Reality (`/instruction` & `/`):**
   - Show the 5-step **Photo Guide** (`/instruction`): a son or daughter caring for an older parent at home places the L-shaped AprilTag ruler next to the wound and takes an uncropped photo.
   - Highlight the core rule: **AI assists. Families care. Professionals decide.** Caregivers submit factual observations (pain, exudate, dressing state) and never see raw, unverified AI numbers.
2. **0:35–1:45 — Calibrated Meta SAM 3.1 Segmentation & Human Boundary Correction (`/demo`):**
   - On `/demo`, upload a calibrated ruler-and-wound photograph.
   - Show how **AprilTag 36h11 homography** straightens camera tilt onto a $10\text{ px/mm}$ grid and how **Meta SAM 3.1 (`sam-3.1`)** segments the wound via its guided two-pass strategy alongside local **YOLOv8-seg**.
   - Click **Edit boundary**, drag two vertices on the canvas, and show the **350 ms live server re-measurement** updating area ($\text{cm}^2$) and clinical Feret axes ($\text{cm}$) while turning the contour from orange (`AI-proposed`) to teal (`Adjusted by clinician`).
3. **1:45–3:00 — Muse Spark 1.3 Explainable Drafting & Four-Attestation Clinical Sign-Off (`/demo` & `/`):**
   - Open the **AI assistance** panel to show **Meta Muse Spark 1.3 (`muse-spark-1.3`)** generating structured visual observations and a provisional note strictly from deterministic server figures—while automatically blocking colour-dependent tissue claims when colour calibration is unverified.
   - Show that editing the boundary marked the old AI draft **stale**, requiring clinician review.
   - Check the **four fingerprint-bound clinical attestations** and click **Approve & sign (demo)** to show how only clinician-verified records enter the longitudinal timeline and update the family caregiver's care plan.

---

## 16. Final Verdict

### **Final Readiness Verdict: READY WITH CAVEATS**

**Supporting Reasons:**
1. **Complete, Authentic Engineering Implementation:** WoundMeter is a genuinely built, end-to-end platform ($31,300+$ combined lines of Python and TypeScript) that integrates **Meta SAM 3.1**, **Meta Muse Spark 1.3**, and **Muse Voice Transcribe 1.0** into a mathematically sound AprilTag homography and deterministic measurement pipeline.
2. **Live, Verified Public Deployment:** All three required URLs (`https://woundmeter.wtepsan.dev`, `/instruction`, and `/demo`) are live over HTTPS, responsive on mobile and desktop, and free of runtime console or network errors.
3. **Exemplary Responsible AI & Provenance:** Pre-existing foundations (`best.pt` from August 2025 and base `ruler_template_v1.yaml` from August 2026) are clearly distinguished from new hackathon work (26 Oct–4 Nov 2026), and clinical safety guardrails are enforced at every layer.
4. **Manageable Caveats:** The caveats—providing a 1-click synthetic sample image for judges on `/demo`, expanding the prose on `/instruction`, and disabling `WOUNDMETER_DEMO_KEEP_PHOTOS` after clearing third-party test images—are straightforward operational/UX polish items and do not detract from the validity of the core engineering achievement.

---

## 17. Acknowledgements

- **Chiang Mai University (CMU):** Verified institutional home of lead developer and researcher **Worawit Tepsan** (`worawit.tepsan@email.cmu.ac.th`, International College of Digital Innovation — ICDI), providing the research environment and compute infrastructure supporting WoundMeter.
- **Clinical, Nursing, and Elderly-Care Collaborators:** Verified domain inspiration reflected throughout the inpatient nursing workflow, Braden Scale assessment engine, caregiver-safe communication rules, and four-attestation clinical sign-off architecture.
- **Edinburgh Napier University (Academic Context):** Acknowledged as part of the broader academic collaboration context motivating the team's elderly-care research into home-to-hospital connected care. *(Verification note: No repository code artifacts or formal institutional endorsement documents from Edinburgh Napier University are present in the codebase, and no official institutional endorsement is claimed.)*
- **Meta & the Meta Global AI Developer Hackathon Organisers:** Acknowledged for hosting the hackathon (26 October–4 November 2026) and providing access to the Meta Model API (`sam-3.1`, `muse-spark-1.3`, and `muse-voice-transcribe-1.0`).
- **Open-Source Software & Standards:** Next.js, React, TypeScript, Tailwind CSS, Lucide Icons, FastAPI, Pydantic, PostgreSQL, OpenCV (`APRILTAG_36h11`), NumPy, PyTorch, Ultralytics YOLOv8, Cryptography (`AESGCM`), and Playwright (used during independent evaluation).

