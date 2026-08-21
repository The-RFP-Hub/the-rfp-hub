/**
 * The M3 report — the M2 one, with M3's identity.
 *
 * It SUBCLASSES rather than copies, and the reason is the part that matters: the rule that a
 * criterion nothing could be checked in is `skip`, never `pass`, and that a run containing one is
 * `incomplete`, never green. That rule is the whole value of a sign-off tool, and a second
 * hand-maintained implementation of it is a second place for it to quietly stop being true.
 *
 * What actually differs between the two tools is the header: this one targets one API and writes
 * fixtures into a namespace, rather than targeting an API and an export root.
 */
import { Report as M2Report } from "../m2-compliance/report.mjs";

export {
  PASS,
  FAIL,
  WARN,
  SKIP,
  INFO,
  INCOMPLETE,
} from "../m2-compliance/report.mjs";

export class Report extends M2Report {
  toJSON() {
    return { ...super.toJSON(), tool: "m3-compliance" };
  }

  render(options = {}) {
    // The two header lines that differ are rewritten by CONTENT rather than by position: a
    // line-offset slice would silently eat a criterion the day somebody adds a header row above.
    return super
      .render(options)
      .replace("RFP Hub — M2 sign-off", "RFP Hub — M3 sign-off")
      .replace(/^ {2}Export root URL .*$/m, `  Namespace        ${this.meta.namespace}`);
  }
}
