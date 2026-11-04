# WoundMeter · 3-minute demo video (rules-compliant)

Target: **2:50–3:00**. About 430 spoken words (~2:52 at 150 words per minute); if you run long, trim Scene 6 first.

The rules say judges must be able to tell what was built during the hackathon (26 Oct–4 Nov), or the project is disqualified. So this script:

- **says what is new in the first 40 seconds**, and names the only two pre-existing parts (the YOLO wound model and the basic ruler measurement);
- **labels every scene** with an on-screen tag: **NEW · built 26 Oct–4 Nov** or **PRE-EXISTING**;
- **frames WoundMeter as a measurement and documentation workflow for care teams**, not AI medical advice and not a simple image analyser: AI never advises patients, and a clinician verifies everything;
- **states the theme** (Build for Your World) and **shows the image licence**.

---

## 1. Prepare (10 minutes, before recording)

**Browser:** Chrome, 1920×1080, zoom 100–110%, bookmarks bar hidden, notifications off. Open these tabs:

| Tab | URL | State before recording |
| :-- | :-- | :-- |
| 1 | https://github.com/wtepsan/WoundMeter | README top (shows the repo is **public**) |
| 2 | https://woundmeter.wtepsan.dev/demo | **Sample A already measured**, record open, Muse Spark draft loaded |
| 3 | https://woundmeter.wtepsan.dev/demo | Fresh page (for sample C) |
| 4 | https://woundmeter.wtepsan.dev | Signed in as **Physician · Dr. Somchai**, patient **Malee Sukjai (P-DEMO-HEAL)** open; on the **AI reports** tab, ask the record assistant *"How has this wound changed?"* and leave the answer on screen |
| 5 | Incognito: https://woundmeter.wtepsan.dev | Signed in as **Home caregiver · Suda**, same patient open |

**Pre-measure sample A in tab 2** (the slow part): **Use this photo** on A → **Measure this photo** → wait for the record **and** the Muse Spark draft under **AI assistance** (~15 s more). Scroll back to the top.

**On-screen tags:** add them in your editor (or as a small text overlay while recording). Exact wording is given in each scene.

**Recorder:** OBS, Loom or QuickTime at 1080p. Record **scene by scene** and join the clips. Do one dry run with a timer.

---

## 2. Script

### Scene 1 · The problem (0:00–0:20) · Tab 1

*Tag: none*

> Anyone confined to bed, after a stroke, surgery or a long illness, can develop pressure wounds within days. Most of them are older adults, and ageing societies like Japan, Thailand and England will have more every year. They're cared for at home by family without clinical training, and nurses can't see every wound every day.

*Action: README top, scroll slowly to the live links.*

### Scene 2 · What it is, and what's new (0:20–0:40) · Tab 1

*Tag: **NEW · built 26 Oct–4 Nov***

> WoundMeter is my entry for **Build for Your World**: it brings Meta's models into elderly care, the field my research comes from. It's not an AI doctor and it gives no advice to patients. It turns a phone photo into a calibrated measurement and documentation that a nurse or physician verifies.
>
> Everything in this video was built during the hackathon, except two parts I'll flag: my earlier YOLO wound model and the basic ruler measurement. I adapted some code from that prototype, but most of it is new, written this week with AI coding assistance.

*Action: scroll to the **Built during the hackathon** OLD/NEW table and hold for 2 seconds.*

### Scene 3 · SAM 3.1 outline and correction (0:40–1:15) · Tab 2

*Tag (first 5 s): **PRE-EXISTING · ruler measurement*** → *then: **NEW · SAM 3.1 integration & boundary editor***

> Here's a sample photo with the printed ruler. Straightening the photo onto the ruler's scale comes from my earlier prototype.
>
> What's new is Meta SAM 3.1. It outlines the whole wound bed, including slough. I built the SAM integration, a decoder for its mask format, and a step where my older YOLO model only points SAM to the right place, so it ignores pen marks and scars. The numbers are computed by code, never by a language model.

*Action: switch **Rectified** / **Original**, hover the outline and the figures.*

> If the outline is wrong, the clinician drags it, and the area re-measures live.

*Action: **Edit boundary**, drag one point, **Done editing**.*

### Scene 4 · Muse Spark documentation and sign-off (1:15–1:40) · Tab 2

*Tag: **NEW · Muse Spark 1.3 & clinician sign-off***

> Muse Spark 1.3 drafts the documentation from the measured figures and describes what's visible; it never diagnoses or stages. The clinician accepts, edits or rejects the draft, and signs with four explicit confirmations. AI never approves anything.

*Action: show the draft under **AI assistance** for 2–3 s; scroll to **Review & sign** and tick the confirmations.*

### Scene 5 · No visible wound (1:40–2:00) · Tab 3

*Tag: **NEW · no-visible-wound workflow***

> Eight weeks later the wound has closed. Instead of failing, WoundMeter reports no visible wound. Zero square centimetres is recorded only after a clinician confirms it.

*Action: **Use this photo** on C → **Measure this photo** (cut the wait in editing) → **No visible wound detected** → **Record 0 cm²**.*

### Scene 6 · Connected care (2:00–2:30) · Tabs 4 and 5

*Tag: **NEW · connected-care platform, Muse Spark assistant & Muse Voice***

> Approved visits build the wound's history: here the verified area falls from eighteen square centimetres to under one. The record assistant uses Muse Spark with tool calling to answer questions from approved data, and nurses can dictate with Muse Voice.

*Action (tab 4): progress chart, then the **AI reports** tab with the assistant's answer and the microphone button.*

> The family sees only what a clinician has approved.

*Action (tab 5): Suda's view with the approved visits only.*

### Scene 7 · Contributions (2:30–2:50) · Tab 1

*Tag: **Public repo: github.com/wtepsan/WoundMeter***

> To recap: before the hackathon I had the YOLO model and the basic ruler. Everything else, the Meta SAM 3.1, Muse Spark and Muse Voice integrations, the boundary editor, clinician sign-off, the no-visible-wound workflow and the care platform, I built in these ten days, mostly as new code written with AI coding assistance. The repository is public and lists it in detail.

*Action: show the OLD/NEW table again, then the repo file list.*

### Scene 8 · Close (2:50–3:00) · Tab 1

*Tag (small, bottom): **Sample images adapted from Jia et al. (2026), CC BY 4.0***

> WoundMeter: AI assists, families care, professionals decide. Try it at woundmeter dot wtepsan dot dev.

*Action: scroll back to the live links. Stop recording.*

---

## 3. Rules checklist (before you submit)

| Rule | How this video and submission meet it |
| :-- | :-- |
| **New work only** | Shows only hackathon features; the two pre-existing parts are named and tagged **PRE-EXISTING** in Scene 3 and recapped in Scene 7, and the video says some prototype code was adapted and most code is new, written with AI coding assistance. |
| **Identify your contributions** | Scene 2 states it up front; every scene has a **NEW** or **PRE-EXISTING** tag; the README has the OLD/NEW table. |
| **Public repo** | Check https://github.com/wtepsan/WoundMeter opens in a private/incognito window **without signing in**. |
| **Team / track** | Solo is allowed. Pick **one** track (Indie Developer or Startup) and enter only that one. |
| **Demo video ≤ 3 minutes** | Trim to 2:50–3:00; upload (YouTube unlisted or Loom) and check the link opens signed-out. |
| **Banned: AI medical or health advice** | Scenes 2 and 4 say it gives no advice and never diagnoses or stages; every result is verified by a clinician. Don't describe it as telling patients what to do. |
| **Banned: simple image analyser** | Show the whole workflow: calibration, SAM outline, correction, documentation, sign-off, history and family view, not just "upload a photo, get an answer". |
| **Rights to assets** | Sample photos are adapted from Jia et al. (2026), CC BY 4.0, credited in the app, README and Scene 8. Don't show other people's photos without permission. |
| **Theme** | Scene 2 names **Build for Your World** (Meta models in elderly care, a domain you know). |
| **Submission** | By **Wed 4 Nov, 9:00 PM ET** at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit, with the public repo, the video link, and every team member added. |

## 4. Make it fast

- **Record scene by scene,** re-take only what you stumble on. Expect 20–30 minutes in total.
- **Never wait on camera.** Sample A and the assistant's answer are prepared in advance; cut or speed up the sample C wait.
- **Don't approve real records on camera.** Sign only in `/demo`, which saves nothing.
- **If you run long,** shorten Scene 6 first (drop the voice sentence), never the contribution statements in Scenes 2, 3 and 7.

## 5. Spoken text only (teleprompter)

Anyone confined to bed, after a stroke, surgery or a long illness, can develop pressure wounds within days. Most of them are older adults, and ageing societies like Japan, Thailand and England will have more every year. They're cared for at home by family without clinical training, and nurses can't see every wound every day.

WoundMeter is my entry for Build for Your World: it brings Meta's models into elderly care, the field my research comes from. It's not an AI doctor and it gives no advice to patients. It turns a phone photo into a calibrated measurement and documentation that a nurse or physician verifies. Everything in this video was built during the hackathon, except two parts I'll flag: my earlier YOLO wound model and the basic ruler measurement. I adapted some code from that prototype, but most of it is new, written this week with AI coding assistance.

Here's a sample photo with the printed ruler. Straightening the photo onto the ruler's scale comes from my earlier prototype. What's new is Meta SAM 3.1. It outlines the whole wound bed, including slough. I built the SAM integration, a decoder for its mask format, and a step where my older YOLO model only points SAM to the right place, so it ignores pen marks and scars. The numbers are computed by code, never by a language model. If the outline is wrong, the clinician drags it, and the area re-measures live.

Muse Spark 1.3 drafts the documentation from the measured figures and describes what's visible; it never diagnoses or stages. The clinician accepts, edits or rejects the draft, and signs with four explicit confirmations. AI never approves anything.

Eight weeks later the wound has closed. Instead of failing, WoundMeter reports no visible wound. Zero square centimetres is recorded only after a clinician confirms it.

Approved visits build the wound's history: here the verified area falls from eighteen square centimetres to under one. The record assistant uses Muse Spark with tool calling to answer questions from approved data, and nurses can dictate with Muse Voice. The family sees only what a clinician has approved.

To recap: before the hackathon I had the YOLO model and the basic ruler. Everything else, the Meta SAM 3.1, Muse Spark and Muse Voice integrations, the boundary editor, clinician sign-off, the no-visible-wound workflow and the care platform, I built in these ten days, mostly as new code written with AI coding assistance. The repository is public and lists it in detail.

WoundMeter: AI assists, families care, professionals decide. Try it at woundmeter dot wtepsan dot dev.
