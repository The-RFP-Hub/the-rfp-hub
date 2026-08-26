import { UntrustedText } from "@/components/UntrustedText";
import {
  auditActionLabel,
  auditActorLabel,
  auditFieldLabels,
  auditTechnicalRecord,
} from "@/lib/presentation";
import type { AuditEntry } from "@/lib/types";

/** Human-facing audit cells with the exact wire record kept one disclosure away. */
export function AuditAction({ entry }: { entry: AuditEntry }) {
  return (
    <>
      {auditActionLabel(entry.action)}
      <details>
        <summary className="muted">Technical record</summary>
        <pre>{JSON.stringify(auditTechnicalRecord(entry), null, 2)}</pre>
      </details>
    </>
  );
}

export function AuditActor({ entry }: { entry: AuditEntry }) {
  return <UntrustedText value={auditActorLabel(entry.actor, entry.actorKind)} />;
}

export function AuditFields({ fields }: { fields: string[] }) {
  if (fields.length === 0) return <span className="muted">—</span>;
  const labels = auditFieldLabels(fields);
  return <>{labels.join(" / ")}</>;
}
