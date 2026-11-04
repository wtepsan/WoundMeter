"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Send, Square, X } from "lucide-react";

import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { askAssistant, CareApiError, transcribeAudio } from "@/lib/care-api";
import { humanize } from "@/lib/care-format";
import type { AssistantAnswer } from "@/lib/care-types";
import { recordingSupported, startRecording, type Recorder } from "@/lib/wav-recorder";

type Turn = { role: "user"; content: string } | { role: "assistant"; answer: AssistantAnswer };

const EXAMPLES = [
  "Summarise the wound history.",
  "Compare the last three visits.",
  "What was the latest approved wound area?",
  "What information is missing from the record?",
  "ช่วยเปรียบเทียบขนาดแผลจากการตรวจสามครั้งล่าสุด",
];

function AnswerView({ answer }: { answer: AssistantAnswer }) {
  return (
    <div className="stack">
      <p className="ai-section-text">{answer.answer}</p>
      {answer.unsupported_numbers.length > 0 && (
        <Notice tone="warning" title="Check these numbers">
          {answer.unsupported_numbers.join(", ")} did not appear in the records the assistant read.
        </Notice>
      )}
      {answer.recorded_facts.length > 0 && (
        <div>
          <strong>Recorded facts</strong>
          <ul className="bullet-list">
            {answer.recorded_facts.map((f, i) => <li key={i}>{f.statement} <Badge tone="neutral">{f.source_ref}</Badge></li>)}
          </ul>
        </div>
      )}
      {answer.calculations.length > 0 && (
        <div>
          <strong>Server calculations</strong>
          <ul className="bullet-list">
            {answer.calculations.map((f, i) => <li key={i}>{f.statement} <Badge tone="info">{f.source_ref}</Badge></li>)}
          </ul>
        </div>
      )}
      {answer.missing_information.length > 0 && (
        <div>
          <strong>Not in the record</strong>
          <ul className="bullet-list">{answer.missing_information.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}
      {answer.created_report_ids.length > 0 && (
        <Notice tone="info" title="Draft report created">
          Open AI reports to review, edit and sign it. It is not final until signed.
        </Notice>
      )}
      <p className="fine-print">
        Read: {answer.sources.map((s) => `${humanize(s.tool)}${s.denied ? " (not permitted)" : ""}`).join(", ") || "nothing"} ·{" "}
        {answer.model} · {(answer.latency_ms / 1000).toFixed(1)} s. {answer.disclaimer}
      </p>
    </div>
  );
}

/** Patient-aware Muse Spark assistant with Thai/English voice input. Clinical staff only. */
export function AssistantPanel({ patientId }: { patientId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"ask" | "transcribe" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<"auto" | "th" | "en">("auto");
  const [recording, setRecording] = useState(false);
  const [fromVoice, setFromVoice] = useState(false);
  const recorder = useRef<Recorder | null>(null);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  useEffect(() => {
    setVoiceAvailable(recordingSupported());
    return () => recorder.current?.cancel();
  }, []);

  async function ask(question: string) {
    const text = question.trim();
    if (!text) return;
    const history = [...turns, { role: "user", content: text } as Turn];
    setTurns(history);
    setInput("");
    setFromVoice(false);
    setBusy("ask");
    setError(null);
    try {
      const messages = history.map((t) => (t.role === "user" ? t : { role: "assistant" as const, content: t.answer.answer }));
      const answer = await askAssistant(patientId, messages);
      setTurns([...history, { role: "assistant", answer }]);
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "The assistant could not answer.");
    } finally {
      setBusy(null);
    }
  }

  async function startVoice() {
    setError(null);
    try {
      recorder.current = await startRecording(() => void stopVoice());
      setRecording(true);
    } catch {
      setError("The microphone is unavailable. Allow microphone access or type the question.");
    }
  }

  async function stopVoice() {
    const active = recorder.current;
    recorder.current = null;
    setRecording(false);
    if (!active) return;
    setBusy("transcribe");
    try {
      const { base64 } = await active.stop();
      const result = await transcribeAudio(base64, language);
      // The transcript is a suggestion: it is only sent after the user checks and confirms it.
      setInput(result.transcript);
      setFromVoice(true);
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "Transcription failed. Type the question instead.");
    } finally {
      setBusy(null);
    }
  }

  function discardVoice() {
    recorder.current?.cancel();
    recorder.current = null;
    setRecording(false);
    if (fromVoice) setInput("");
    setFromVoice(false);
  }

  return (
    <div className="stack">
      <p className="fine-print">
        Answers come only from this patient&apos;s records that you are allowed to see. Changes are calculated by the
        server; the assistant cannot sign, diagnose or prescribe. Questions are not stored; the audit log records which
        records were read.
      </p>
      {turns.length === 0 && (
        <div className="button-row" aria-label="Example questions">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="demo-chip" disabled={busy !== null} onClick={() => void ask(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
      <ol className="ai-chat" aria-label="Conversation" aria-live="polite">
        {turns.map((turn, index) => (
          <li key={index} className={turn.role === "user" ? "ai-chat-user" : "ai-chat-answer"}>
            {turn.role === "user" ? <strong>{turn.content}</strong> : <AnswerView answer={turn.answer} />}
          </li>
        ))}
      </ol>
      {busy === "ask" && <Loading label="Reading the record (about 10–20 s)…" />}
      {busy === "transcribe" && <Loading label="Transcribing…" />}
      {error && <Notice tone="danger" title="Assistant">{error}</Notice>}
      {fromVoice && (
        <Notice tone="info" title="Check the transcript">Edit it if needed, then send. Nothing is sent until you confirm.</Notice>
      )}
      <div className="field">
        <label htmlFor="assistant-input">{fromVoice ? "Transcript (editable)" : "Question"}</label>
        <textarea id="assistant-input" rows={2} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }} />
      </div>
      <div className="button-row">
        <button type="button" className="button" disabled={busy !== null || recording || !input.trim()} onClick={() => void ask(input)}>
          <Send aria-hidden="true" className="inline-icon" /> {fromVoice ? "Confirm and send" : "Send"}
        </button>
        {voiceAvailable && !recording && (
          <button type="button" className="button secondary" disabled={busy !== null} onClick={() => void startVoice()}>
            <Mic aria-hidden="true" className="inline-icon" /> Speak
          </button>
        )}
        {recording && (
          <button type="button" className="button secondary" onClick={() => void stopVoice()}>
            <Square aria-hidden="true" className="inline-icon" /> Stop and transcribe
          </button>
        )}
        {(recording || fromVoice) && (
          <button type="button" className="button ghost" onClick={discardVoice}>
            <X aria-hidden="true" className="inline-icon" /> Discard
          </button>
        )}
        {voiceAvailable && (
          <label className="field-hint">
            Voice language{" "}
            <select value={language} onChange={(e) => setLanguage(e.target.value as "auto" | "th" | "en")} disabled={recording}>
              <option value="auto">Thai or English</option>
              <option value="th">Thai</option>
              <option value="en">English</option>
            </select>
          </label>
        )}
      </div>
      {recording && <p role="status">Recording… speak your question (up to 60 seconds).</p>}
    </div>
  );
}
