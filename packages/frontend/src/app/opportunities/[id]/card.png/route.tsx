/**
 * The share card: one 1200×630 PNG per published listing, at `GET /opportunities/[id]/card.png`.
 *
 * READS THE PUBLIC ROUTE, same as the page it illustrates: `directory.find` is
 * `GET /v1/opportunities/{id}`, which 404s anything that is not `approved AND is_listed`. There is
 * no separate "does this listing exist" check — a 404 from the API IS "not published" here, and
 * this route answers with its own 404 rather than drawing a card for something nobody can read.
 *
 * FONTS ARE VENDORED, not fetched at request time. `lib/fonts.ts` self-hosts the app's three
 * typefaces through `next/font/google`, which resolves them at BUILD time into hashed
 * `/_next/static/media/…` files — there is no supported, non-hashed path from a route handler back
 * to those build artifacts at runtime. Fetching from a font CDN per request was rejected outright:
 * it would leak every viewer's IP to a third party the moment they opened a listing, which is the
 * exact leak `lib/fonts.ts` documents refusing to reopen. Vendoring two static TTF instances next
 * to this route (`src/assets/fonts`, OFL-licensed, instanced once from Google Fonts' variable files
 * with `fonttools varLib.instancer`) keeps every byte on this origin — the file ships in the
 * function bundle, not on the wire to a stranger's DNS.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, createApiClient } from "@/lib/api";
import { shareCardModel } from "@/lib/share-card";
import { requestOrigin } from "@/lib/site-origin";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";

const INK = "#1a1917";
const PAPER = "#fcfcfa";
const SECONDARY = "#a8a29e";

const FONT_DIR = join(process.cwd(), "src", "assets", "fonts");

let fontsPromise: Promise<{ display: ArrayBuffer; body: ArrayBuffer }> | null = null;

/** Read once per server process — the files never change while it is running. */
function loadFonts() {
  fontsPromise ??= Promise.all([
    readFile(join(FONT_DIR, "LibreFranklin-800.ttf")),
    readFile(join(FONT_DIR, "PublicSans-400.ttf")),
  ]).then(([display, body]) => ({
    display: display.buffer.slice(display.byteOffset, display.byteOffset + display.byteLength),
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  })) as Promise<{ display: ArrayBuffer; body: ArrayBuffer }>;
  return fontsPromise;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) return new Response("The API is not configured.", { status: 500 });

  const api = createApiClient({ baseUrl: apiUrl });

  let entry: Awaited<ReturnType<typeof api.directory.find>>;
  try {
    entry = await api.directory.find(id);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) {
      return new Response("Not found.", { status: 404 });
    }
    throw error;
  }

  const origin = (await requestOrigin()) ?? new URL(apiUrl).origin;
  const model = shareCardModel(entry, origin);
  const { display, body } = await loadFonts();

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
        <div style={{ fontSize: 28, color: SECONDARY, letterSpacing: 1 }}>{model.eyebrow}</div>
        <div
          style={{
            display: "flex",
            marginTop: 24,
            fontFamily: "Libre Franklin",
            fontWeight: 800,
            fontSize: 60,
            lineHeight: 1.12,
            maxHeight: 3 * 60 * 1.12,
            overflow: "hidden",
          }}
        >
          {model.title}
        </div>
        {model.ecosystems ? (
          <div style={{ marginTop: 28, fontSize: 26, color: SECONDARY }}>{model.ecosystems}</div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", gap: 96 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 22, color: SECONDARY }}>Award</div>
            <div
              style={{
                marginTop: 8,
                fontFamily: "Libre Franklin",
                fontWeight: 800,
                fontSize: 44,
              }}
            >
              {model.award}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 22, color: SECONDARY }}>Next deadline</div>
            <div
              style={{
                marginTop: 8,
                fontFamily: "Libre Franklin",
                fontWeight: 800,
                fontSize: 44,
              }}
            >
              {model.deadline}
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 40,
            paddingTop: 24,
            borderTop: `1px solid ${SECONDARY}`,
            fontSize: 22,
            color: SECONDARY,
          }}
        >
          <div style={{ display: "flex" }}>{model.url}</div>
          <div style={{ display: "flex" }}>{model.positioning}</div>
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
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    },
  );
}
