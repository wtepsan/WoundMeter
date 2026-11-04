# WoundMeter · 3-minute demo video

Target: **2:55–3:00**. About 400 spoken words (~2:40 at a calm 150 words per minute), leaving ~20 seconds for clicks and pauses.
Rule of thumb: **show, don't wait.** Anything that takes time (AI measuring, Muse writing) is prepared before you press record.

---

## 1. Prepare (10 minutes, before recording)

**Browser (Chrome, 1920×1080, zoom 100–110%, bookmarks bar hidden). Open these tabs in this order:**

| Tab | URL | State before recording |
| :-- | :-- | :-- |
| 1 | https://github.com/wtepsan/WoundMeter | README at the top |
| 2 | https://woundmeter.wtepsan.dev/demo | **Sample A already measured** (see below), record open |
| 3 | https://woundmeter.wtepsan.dev/demo | Fresh page, nothing selected (for sample C) |
| 4 | https://woundmeter.wtepsan.dev | Signed in as **Physician · Dr. Somchai**, patient **Malee Sukjai (P-DEMO-HEAL)** open on the wound |
| 5 | Incognito window: https://woundmeter.wtepsan.dev | Signed in as **Home caregiver · Suda**, same patient open |

**Pre-measure sample A in tab 2** (this is the slow part, about 20–40 s):
1. Press **Use this photo** on sample A, then **Measure this photo**.
2. Wait until the record opens **and** the Muse Spark draft has appeared under **AI assistance** (about 15 s more).
3. Scroll back to the top of the record. Do not edit anything yet.

**Also check:**
- Close notifications (Slack, mail, OS banners). Silence the phone.
- Do one full dry run with a timer. If a segment runs long, cut words, not clicks.
- Use the incognito window for Suda so the two sign-ins don't log each other out.

**Recorder:** OBS, Loom or QuickTime, 1080p, microphone close to your mouth. Record **one segment at a time** (the numbered scenes below) and join them; it is much faster than one perfect take.

---

## 2. Script

### Scene 1 · Hook (0:00–0:25) · Tab 1 (README top)

> Anyone confined to bed, after a stroke, surgery or a long illness, can develop pressure wounds within days. Most of them are older adults, and ageing societies like Japan, Thailand and England will have more every year. They're cared for at home by family without clinical training. Nurses can't be at every bedside, and what reaches them is a phone photo taken from a different distance every time, so nobody can tell if the wound is healing.

*Action: slowly scroll from the tagline to the live links.*

### Scene 2 · The idea (0:25–0:38) · Tab 1

> WoundMeter fixes that. **AI assists, families care, professionals decide.** A family member takes one photo with a printed ruler. Meta AI helps measure and document it. A clinician verifies everything before it counts.

*Action: point the cursor at the flow line "Photo capture → … → longitudinal tracking".*

### Scene 3 · Calibrated measurement with SAM 3.1 (0:38–1:15) · Tab 2

> Here's sample photo A in our live demo. The four AprilTag markers on the ruler let us correct camera tilt and map the wound onto a fixed grid of ten pixels per millimetre, so every photo is measured on the same scale.
>
> Meta SAM 3.1 outlines the wound. Our local YOLO model tells SAM where to look, so it ignores pen marks and scars around the wound. The area, length and width are computed by our own code, never by a language model.

*Action: switch between the **Rectified** and **Original** views; hover the outline and the measurement figures.*

> If the outline isn't right, the clinician just drags it. The area re-measures live.

*Action: press **Edit boundary**, drag one point outward, watch the area change, press **Done editing**.*

### Scene 4 · Muse Spark and sign-off (1:15–1:40) · Tab 2

> Muse Spark 1.3 drafts the documentation from the measured figures only, and is kept to describing, never diagnosing or staging. The clinician accepts, edits or rejects it, then signs with four explicit confirmations. Nothing is approved by AI.

*Action: scroll to **AI assistance**, show the draft for 2–3 seconds, then scroll to **Review & sign** and tick the four confirmations. (Don't fill the whole form on camera.)*

### Scene 5 · Healed wound (1:40–2:00) · Tab 3

> What about a wound that has healed? Here's photo C, eight weeks later.

*Action: **Use this photo** on sample C → **Measure this photo**. While it measures (about 10 s), keep talking:*

> Most tools would just fail here. WoundMeter recognises there's no open wound and says so.

*Action: the **No visible wound detected** notice appears; point at **Record 0 cm²**, **Draw outline** and **Retake photo**. Press **Record 0 cm²** to show the 0 cm² record.*

> Zero square centimetres is a real result, but only a clinician can confirm it, and only a clinician can mark the wound healed.

### Scene 6 · Connected care (2:00–2:30) · Tabs 4 and 5

> Every approved visit builds the wound's history. For our fictional patient, the verified area fell from eighteen square centimetres to under one.

*Action (tab 4, Dr. Somchai): show the progress chart and the visit list (18.37 → 0.86 cm², third photo "No visible wound").*

> The family sees only what a clinician has approved, with clear care instructions.

*Action (tab 5, Suda): show the same patient from the caregiver's view, with only the approved visits.*

### Scene 7 · What I built (2:30–2:50) · Tab 1

> The idea, a YOLO wound model and a basic ruler came from earlier joint research. In these ten days I built the Meta SAM 3.1 and Muse Spark integration, voice dictation, colour and dynamic ruler calibration, the boundary editor, clinician sign-off, the healed-wound workflow, and the whole connected-care platform.

*Action: scroll to **Built during the hackathon** (OLD vs NEW table).*

### Scene 8 · Close (2:50–3:00) · Tab 1

> WoundMeter: AI assists, families care, professionals decide. Try it yourself at woundmeter dot wtepsan dot dev, with no ruler needed.

*Action: scroll back to the live links at the top. Stop recording.*

---

## 3. Make it fast

- **Record scene by scene,** re-take only the one you stumble in, then join the clips. Total recording time is usually 20–30 minutes.
- **Never wait on camera.** Sample A is pre-measured. If sample C takes long, cut the wait in editing (or speed it up 2×) and keep the voiceover.
- **Speak the script, click second.** If you are short of breath, drop the sentence in *Scene 3* about pen marks; it is the least essential.
- **Do not change real records on camera.** Use `/demo` for anything you sign or record as 0 cm²; it saves nothing. In the signed-in app, only show the patient, don't approve.
- **Captions help judges:** YouTube or Loom auto-captions are fine; fix "SAM", "Muse Spark" and "wtepsan".
- **Final check:** total length ≤ 3:00, sound audible at laptop volume, the live URL visible at the start and the end.

## 4. Spoken text only (for a teleprompter)

Anyone confined to bed, after a stroke, surgery or a long illness, can develop pressure wounds within days. Most of them are older adults, and ageing societies like Japan, Thailand and England will have more every year. They're cared for at home by family without clinical training. Nurses can't be at every bedside, and what reaches them is a phone photo taken from a different distance every time, so nobody can tell if the wound is healing.

WoundMeter fixes that. AI assists, families care, professionals decide. A family member takes one photo with a printed ruler. Meta AI helps measure and document it. A clinician verifies everything before it counts.

Here's sample photo A in our live demo. The four AprilTag markers on the ruler let us correct camera tilt and map the wound onto a fixed grid of ten pixels per millimetre, so every photo is measured on the same scale. Meta SAM 3.1 outlines the wound. Our local YOLO model tells SAM where to look, so it ignores pen marks and scars around the wound. The area, length and width are computed by our own code, never by a language model. If the outline isn't right, the clinician just drags it. The area re-measures live.

Muse Spark 1.3 drafts the documentation from the measured figures only, and is kept to describing, never diagnosing or staging. The clinician accepts, edits or rejects it, then signs with four explicit confirmations. Nothing is approved by AI.

What about a wound that has healed? Here's photo C, eight weeks later. Most tools would just fail here. WoundMeter recognises there's no open wound and says so. Zero square centimetres is a real result, but only a clinician can confirm it, and only a clinician can mark the wound healed.

Every approved visit builds the wound's history. For our fictional patient, the verified area fell from eighteen square centimetres to under one. The family sees only what a clinician has approved, with clear care instructions.

The idea, a YOLO wound model and a basic ruler came from earlier joint research. In these ten days I built the Meta SAM 3.1 and Muse Spark integration, voice dictation, colour and dynamic ruler calibration, the boundary editor, clinician sign-off, the healed-wound workflow, and the whole connected-care platform.

WoundMeter: AI assists, families care, professionals decide. Try it yourself at woundmeter dot wtepsan dot dev, with no ruler needed.
