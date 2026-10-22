"use client";

// Chat actions shared by the hands-free controllers (hand gestures, face gestures).

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
};

let speech: SpeechRec | undefined;
const listeners = new Set<(on: boolean) => void>();
const notify = (on: boolean) => listeners.forEach((l) => l(on));

/** Subscribe to dictation on/off (for a 🎤 indicator). Returns an unsubscribe function. */
export function onListening(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Set a React-controlled input's value so its onChange fires. */
function setReactInput(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Start voice dictation into the page's chat box. Returns a status line. */
export function startDictation(sendHint: string): string {
  const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
  if (!input) return "Open a job or chat to dictate";
  const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
  if (!Ctor) return "This browser can't do voice dictation (try Chrome)";
  if (speech) return "Already listening";
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  const before = input.value ? `${input.value} ` : "";
  rec.onresult = (e) => {
    const results = (e as { results: ArrayLike<ArrayLike<{ transcript: string }>> }).results;
    let text = "";
    for (let i = 0; i < results.length; i++) text += results[i]![0]!.transcript;
    setReactInput(input, before + text.trim());
  };
  rec.onend = () => {
    speech = undefined;
    notify(false);
  };
  speech = rec;
  notify(true);
  input.focus();
  rec.start();
  return `🎤 Listening… ${sendHint} to send`;
}

/** Send the chat box (stopping dictation first so the last words land). Resolves to a status line. */
export async function sendChat(): Promise<string> {
  if (speech) {
    speech.stop();
    await new Promise((r) => setTimeout(r, 400));
  }
  const btn = document.querySelector<HTMLButtonElement>("[data-chat-send]");
  if (!btn) return "No chat box on this page";
  if (btn.disabled) return "Nothing to send";
  btn.click();
  return "Sent";
}

export function stopDictation(): void {
  speech?.stop();
}
