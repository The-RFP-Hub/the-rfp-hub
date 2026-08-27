/**
 * The M4 report — the M2 one, with M4's identity. Same reasoning as `m3-compliance/report.mjs`:
 * the rule that a criterion nothing could be checked in is `skip`, never `pass`, has exactly one
 * implementation, in `m2-compliance/report.mjs`. This subclasses it rather than re-implementing it.
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
    return { ...super.toJSON(), tool: "m4-compliance" };
  }

  render(options = {}) {
    // `meta.baseUrl` is the API origin (so the inherited "API base URL" line is already correct);
    // the inherited "Export root URL" line is repointed at the site under test instead.
    return super
      .render(options)
      .replace("RFP Hub — M2 sign-off", "RFP Hub — M4 sign-off")
      .replace(/^ {2}Export root URL .*$/m, `  Site URL         ${this.meta.siteUrl}`);
  }
}
