/**
 * THE SITE'S OWN CARD: what a link to the front page, the directory or any other page shows in a
 * chat or a feed. Drawn from the open set at request time, so the numbers are the index's real
 * numbers and never a screenshot that goes stale.
 */
import { createApiClient } from "@/lib/api";
import { INK, PAPER, SECONDARY, loadCardFonts } from "@/lib/card-fonts";
import { readConfig } from "@/lib/config";
import { formatCount } from "@/lib/format";
import { compactUsd, summarizeLanding } from "@/lib/landing";
import { loadOpenSet } from "@/lib/open-set";
import { requestOrigin } from "@/lib/site-origin";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";

const CREDIT = "Funded by the Ethereum Foundation Ecosystem Support Program";

export async function GET() {
  const config = readConfig({ apiUrl: process.env.NEXT_PUBLIC_API_URL });
  if (!config.ok) return new Response("The API is not configured.", { status: 500 });

  let figures: { label: string; value: string }[] = [];
  try {
    const summary = summarizeLanding(
      await loadOpenSet(createApiClient({ baseUrl: config.config.apiBaseUrl })),
    );
    figures = [
      { label: "Open opportunities", value: formatCount(summary.open) },
      { label: "Max awards listed", value: compactUsd(summary.awardsUsd) },
      { label: "Organizations", value: formatCount(summary.organizations) },
      { label: "Closing in 30 days", value: formatCount(summary.closingSoonTotal) },
    ];
  } catch {
    // The card still says what the site is; it just carries no numbers.
  }

  const origin = (await requestOrigin()) ?? new URL(config.config.apiBaseUrl).origin;
  const host = origin.replace(/^https?:\/\//, "");
  const { display, body } = await loadCardFonts();

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: INK,
        color: PAPER,
        padding: "64px 72px",
        fontFamily: "Public Sans",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 28, color: SECONDARY, letterSpacing: 1 }}>RFP Hub</div>
        <div
          style={{
            display: "flex",
            marginTop: 20,
            fontFamily: "Libre Franklin",
            fontWeight: 800,
            fontSize: 64,
            lineHeight: 1.08,
          }}
        >
          Open funding on Ethereum: grants, hackathons, bounties, RFPs.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {figures.length > 0 ? (
          <div style={{ display: "flex", gap: 72 }}>
            {figures.map((figure) => (
              <div key={figure.label} style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 20, color: SECONDARY }}>{figure.label}</div>
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: "Libre Franklin",
                    fontWeight: 800,
                    fontSize: 48,
                  }}
                >
                  {figure.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 36,
            paddingTop: 22,
            borderTop: `1px solid ${SECONDARY}`,
            fontSize: 22,
            color: SECONDARY,
          }}
        >
          <div
            style={{ display: "flex", fontFamily: "Libre Franklin", fontWeight: 800, color: PAPER }}
          >
            {CREDIT}
          </div>
          <div style={{ display: "flex", marginTop: 8 }}>{host}</div>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Libre Franklin", data: display, weight: 800, style: "normal" },
        { name: "Public Sans", data: body, weight: 400, style: "normal" },
      ],
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=21600" },
    },
  );
}
