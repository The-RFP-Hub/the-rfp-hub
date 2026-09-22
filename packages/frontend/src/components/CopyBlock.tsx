"use client";

import { IconLabel } from "@/components/IconLabel";
import { ClipboardDocumentIcon } from "@heroicons/react/20/solid";
import { useState } from "react";

export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [note, setNote] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied");
    } catch {
      setNote("Could not copy. Select the text and copy it by hand.");
    }
  };

  return (
    <div className="copy-block">
      <pre className="code-block">{text}</pre>
      <div className="row">
        <button type="button" onClick={() => void copy()}>
          <IconLabel icon={ClipboardDocumentIcon}>{label}</IconLabel>
        </button>
        {note ? (
          <output className="muted" aria-live="polite">
            {note}
          </output>
        ) : null}
      </div>
    </div>
  );
}
