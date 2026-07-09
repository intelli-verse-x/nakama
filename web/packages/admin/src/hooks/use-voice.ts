import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice layer for the copilot: SpeechRecognition mic with interim transcript
 * and auto-send on silence, speechSynthesis TTS, and a hands-free
 * conversation mode that re-opens the mic after each spoken reply.
 * Everything degrades gracefully when the Web Speech API is unavailable.
 */

interface SpeechRecognitionResultLike {
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Markdown → plain speakable text (drop code, links, tables, symbols). */
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SPEAK_PREF_KEY = "nakama-copilot-speak";
const HANDSFREE_PREF_KEY = "nakama-copilot-handsfree";

export interface UseVoiceOptions {
  /** Called with the final transcript once the user pauses (auto-send). */
  onFinalTranscript: (text: string) => void;
  /** Live interim transcript while the user is speaking. */
  onInterimTranscript?: (text: string) => void;
}

export function useVoice({ onFinalTranscript, onInterimTranscript }: UseVoiceOptions) {
  const [supported, setSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakEnabled, setSpeakEnabled] = useState(false);
  const [handsFree, setHandsFree] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const handsFreeRef = useRef(false);
  const listeningRef = useRef(false);
  // Callbacks live in refs so recognition handlers (async) see the latest.
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;
  const onInterimRef = useRef(onInterimTranscript);
  onInterimRef.current = onInterimTranscript;

  useEffect(() => {
    setSupported(Boolean(getSpeechRecognition()));
    setTtsSupported(typeof window !== "undefined" && "speechSynthesis" in window);
    try {
      setSpeakEnabled(localStorage.getItem(SPEAK_PREF_KEY) === "1");
      const hf = localStorage.getItem(HANDSFREE_PREF_KEY) === "1";
      setHandsFree(hf);
      handsFreeRef.current = hf;
    } catch {
      /* storage blocked — defaults are fine */
    }
    return () => {
      recognitionRef.current?.stop();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const startListening = useCallback(() => {
    if (listeningRef.current) return;
    const SR = getSpeechRecognition();
    if (!SR) return;
    // Don't transcribe our own TTS voice.
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    transcriptRef.current = "";
    rec.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      transcriptRef.current = text;
      onInterimRef.current?.(text);
    };
    rec.onend = () => {
      listeningRef.current = false;
      setListening(false);
      recognitionRef.current = null;
      onInterimRef.current?.("");
      // Voice = command: auto-send once the user pauses.
      const finalText = transcriptRef.current.trim();
      if (finalText) onFinalRef.current(finalText);
    };
    rec.onerror = () => {
      listeningRef.current = false;
      setListening(false);
      recognitionRef.current = null;
      onInterimRef.current?.("");
    };
    recognitionRef.current = rec;
    listeningRef.current = true;
    setListening(true);
    rec.start();
  }, []);

  const toggleListening = useCallback(() => {
    if (listeningRef.current) stopListening();
    else startListening();
  }, [startListening, stopListening]);

  const toggleSpeakEnabled = useCallback(() => {
    setSpeakEnabled((v) => {
      const next = !v;
      try {
        localStorage.setItem(SPEAK_PREF_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      if (!next && typeof window !== "undefined") {
        window.speechSynthesis?.cancel();
        setSpeaking(false);
      }
      return next;
    });
  }, []);

  const toggleHandsFree = useCallback(() => {
    setHandsFree((v) => {
      const next = !v;
      handsFreeRef.current = next;
      try {
        localStorage.setItem(HANDSFREE_PREF_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      // Hands-free implies spoken replies — that's what the mic re-opens after.
      if (next) {
        setSpeakEnabled(true);
        try {
          localStorage.setItem(SPEAK_PREF_KEY, "1");
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (markdown: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      const clean = stripMarkdownForSpeech(markdown);
      if (!clean) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(clean.slice(0, 1500));
      utterance.rate = 1.05;
      utterance.onstart = () => setSpeaking(true);
      const finish = () => {
        setSpeaking(false);
        // Hands-free conversation: reply spoken -> mic re-opens for the user.
        if (handsFreeRef.current) startListening();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    },
    [startListening],
  );

  return {
    supported,
    ttsSupported,
    listening,
    speaking,
    speakEnabled,
    handsFree,
    startListening,
    stopListening,
    toggleListening,
    toggleSpeakEnabled,
    toggleHandsFree,
    speak,
    stopSpeaking,
  };
}
