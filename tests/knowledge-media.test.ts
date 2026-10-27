import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { captionSegments, linkKind, looksLikeEpisode, transcribeBytes, mp3Pieces, readPodcast, readYouTube, timedText, transcriptText, youtubeId } from "@/lib/knowledge/media";

const LLM = "https://llm.test/v1";
const lookup = async () => ["93.184.216.34"];

type Handler = (url: string, init: RequestInit | undefined) => Response | null | Promise<Response | null>;

function fake(handler: Handler) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const response = await handler(url, init);
    if (!response) throw new Error(`Unexpected ${init?.method ?? "GET"} ${url}`);
    return response;
  };
  return { fetchImpl, calls };
}

function player(tracks: unknown[], status = "OK") {
  return Response.json({
    playabilityStatus: { status },
    videoDetails: { title: "How Acme sells", author: "Acme TV", shortDescription: "Our sales playbook." },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  });
}

describe("knowledge media", () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE_URL = LLM;
  });

  afterEach(() => {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_API_BASE_URL;
    delete process.env.SUPADATA_API_KEY;
  });

  it("recognises YouTube, podcast and plain links", () => {
    for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ?si=x"]) {
      assert.equal(youtubeId(url), "dQw4w9WgXcQ", url);
    }
    assert.equal(youtubeId("https://www.youtube.com/@acme"), null);
    assert.equal(linkKind("https://youtu.be/dQw4w9WgXcQ"), "youtube");
    assert.equal(linkKind("https://podcasts.apple.com/gb/podcast/the-show/id123?i=1000456"), "podcast");
    assert.equal(linkKind("https://cdn.example.com/episodes/42.mp3?x=1"), "podcast");
    assert.equal(linkKind("https://acme.com/about"), "link");
  });

  it("groups timed captions into paragraphs with timestamps", () => {
    const text = timedText([
      { startMs: 0, text: "Hello" },
      { startMs: 2000, text: "and welcome." },
      { startMs: 61_000, text: "Next part." },
      { startMs: 3_725_000, text: "Much later." },
    ]);
    assert.equal(text, "[0:00] Hello and welcome.\n\n[1:01] Next part.\n\n[1:02:05] Much later.");
  });

  it("reads YouTube captions in JSON and both XML formats", () => {
    assert.deepEqual(captionSegments(JSON.stringify({ events: [{ tStartMs: 10, segs: [{ utf8: "Hi" }, { utf8: " all" }] }] })), [{ startMs: 10, text: "Hi all" }]);
    assert.deepEqual(captionSegments(`<transcript><text start="1.5" dur="2">Fish &amp;amp; chips</text></transcript>`), [{ startMs: 1500, text: "Fish & chips" }]);
  });

  it("reads WebVTT, SRT and podcast JSON transcripts with speakers", () => {
    const vtt = "WEBVTT\n\n00:00.000 --> 00:02.000\n<v Jane>Hello there.\n\n00:02.000 --> 00:04.000\n<v Jane>Welcome back.\n\n00:04.000 --> 00:06.000\n<v Sam>Thanks.";
    assert.equal(transcriptText(vtt, "text/vtt"), "Jane: Hello there. Welcome back.\n\nSam: Thanks.");
    const srt = "1\n00:00:00,000 --> 00:00:02,000\nFirst line\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond line";
    assert.equal(transcriptText(srt, "application/srt"), "First line Second line");
    const json = JSON.stringify({ segments: [{ speaker: "Jane", body: "Hi." }, { speaker: "Jane", body: "Again." }, { speaker: "Sam", body: "Yes." }] });
    assert.equal(transcriptText(json, "application/json"), "Jane: Hi. Again.\n\nSam: Yes.");
  });

  it("splits large MP3s on frame boundaries", () => {
    const bytes = new Uint8Array(25);
    bytes.fill(1);
    bytes[11] = 0xff;
    bytes[12] = 0xfb;
    bytes[21] = 0xff;
    bytes[22] = 0xfb;
    const pieces = mp3Pieces(bytes, 10);
    assert.deepEqual(pieces.map((piece) => piece.length), [11, 10, 4]);
    assert.equal(pieces[1][0], 0xff);
  });

  it("reads YouTube captions, preferring English made by people", async () => {
    const { fetchImpl, calls } = fake((url) => {
      if (url.startsWith("https://www.youtube.com/youtubei/v1/player")) {
        return player([
          { baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr", languageCode: "en", kind: "asr" },
          { baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-GB", languageCode: "en-GB" },
        ]);
      }
      if (url === "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-GB") {
        return new Response(`<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="0" d="2000"><s>We&#39;re</s><s t="200"> selling</s></p><p t="1800" w="1" a="1">\n</p><p t="2500">to finance teams.</p></body></timedtext>`, {
          headers: { "content-type": "text/xml" },
        });
      }
      return null;
    });
    const result = await readYouTube("https://youtu.be/dQw4w9WgXcQ", { fetchImpl, lookup });
    assert.equal(result.title, "How Acme sells");
    assert.equal(result.text, "Channel: Acme TV\n\nDescription:\nOur sales playbook.\n\nTranscript:\n[0:00] We're selling to finance teams.");
    assert.equal(calls.length, 2);
  });

  it("falls back to Supadata when YouTube won't share captions, and explains when it isn't set up", async () => {
    const handler: Handler = (url) => {
      if (url.startsWith("https://www.youtube.com/youtubei/v1/player")) return player([], "LOGIN_REQUIRED");
      if (url.startsWith("https://www.youtube.com/oembed")) return Response.json({ title: "Acme keynote", author_name: "Acme" });
      if (url === "https://api.supadata.ai/v1/transcript?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&text=false") return Response.json({ jobId: "job-1" }, { status: 202 });
      if (url === "https://api.supadata.ai/v1/transcript/job-1") return Response.json({ status: "completed", content: [{ text: "Welcome to the keynote.", offset: 1000 }] });
      return null;
    };
    await assert.rejects(readYouTube("https://youtu.be/dQw4w9WgXcQ", { ...fake(handler), lookup }), /Set SUPADATA_API_KEY/);
    process.env.SUPADATA_API_KEY = "supa";
    const result = await readYouTube("https://youtu.be/dQw4w9WgXcQ", { ...fake(handler), lookup });
    assert.equal(result.title, "How Acme sells");
    assert.match(result.text, /Transcript:\n\[0:01\] Welcome to the keynote\.$/);
  });

  it("uses a podcast's published transcript from its feed when there is one", async () => {
    const { fetchImpl, calls } = fake((url) => {
      if (url.startsWith("https://itunes.apple.com/lookup?id=123")) {
        return Response.json({
          results: [
            { wrapperType: "track", kind: "podcast", collectionName: "Revenue Show", feedUrl: "https://feeds.example.com/revenue.xml" },
            { wrapperType: "podcastEpisode", trackId: 1000456, trackName: "Pricing with Jane", collectionName: "Revenue Show", episodeUrl: "https://cdn.example.com/ep42.mp3?src=apple", description: "Jane on pricing." },
          ],
        });
      }
      if (url === "https://feeds.example.com/revenue.xml") {
        return new Response(
          `<?xml version="1.0"?><rss><channel><title>Revenue Show</title><item><title>Other</title><enclosure url="https://cdn.example.com/ep41.mp3"/></item><item><title>Pricing with Jane</title><enclosure url="https://cdn.example.com/ep42.mp3"/><podcast:transcript url="https://cdn.example.com/ep42.html" type="text/html"/><podcast:transcript url="https://cdn.example.com/ep42.vtt" type="text/vtt"/></item></channel></rss>`,
          { headers: { "content-type": "application/rss+xml" } },
        );
      }
      if (url === "https://cdn.example.com/ep42.vtt") return new Response(`WEBVTT\n\n00:00.000 --> 00:05.000\n<v Jane>${"Value based pricing works when you know the outcome. ".repeat(6)}`, { headers: { "content-type": "text/vtt" } });
      return null;
    });
    const result = await readPodcast("https://podcasts.apple.com/gb/podcast/revenue-show/id123?i=1000456", { fetchImpl, lookup });
    assert.equal(result.title, "Pricing with Jane · Revenue Show");
    assert.match(result.text, /^Show: Revenue Show\n\nEpisode notes:\nJane on pricing\.\n\nTranscript:\nJane: Value based pricing/);
    assert.ok(!calls.some((call) => call.includes(".mp3")));
    assert.ok(!calls.some((call) => call.includes("ep42.html")));
  });

  it("transcribes episode audio in pieces when there's no transcript", async () => {
    const audio = new Uint8Array(12 * 1024 * 1024);
    audio.set([0x49, 0x44, 0x33]);
    audio[9 * 1024 * 1024 + 100] = 0xff;
    audio[9 * 1024 * 1024 + 101] = 0xfb;
    const uploads: number[] = [];
    const { fetchImpl } = fake(async (url, init) => {
      if (url === "https://show.example.com/episodes/42") {
        return new Response(`<html><head><title>Episode 42</title><meta property="og:audio" content="/media/42.mp3"></head></html>`, { headers: { "content-type": "text/html" } });
      }
      if (url === "https://show.example.com/media/42.mp3") return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
      if (url === `${LLM}/audio/transcriptions`) {
        const form = init?.body as FormData;
        assert.equal(form.get("model"), "universal-2");
        const file = form.get("file") as File;
        uploads.push(file.size);
        return Response.json({ text: uploads.length === 1 ? "Part one." : "Part two." });
      }
      return null;
    });
    const result = await readPodcast("https://show.example.com/episodes/42", { fetchImpl, lookup });
    assert.equal(result.title, "Episode 42");
    assert.deepEqual(uploads, [9 * 1024 * 1024 + 100, 3 * 1024 * 1024 - 100]);
    assert.equal(result.text, "Transcript:\nPart one.\n\nPart two.");
    await assert.rejects(readPodcast("https://open.spotify.com/episode/abc", { fetchImpl, lookup }), /Spotify doesn't share episode audio/);
  });

  it("spots episode pages and feeds among plain links", async () => {
    const { fetchImpl } = fake((url) => {
      if (url === "https://show.example.com/ep/7") return new Response(`<html><head><meta property="og:audio" content="https://cdn.example.com/7.mp3"></head></html>`, { headers: { "content-type": "text/html" } });
      if (url === "https://show.example.com/feed") return new Response(`<rss><channel><item><enclosure url="https://cdn.example.com/7.mp3"/></item></channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
      if (url === "https://news.example.com/story") return new Response(`<html><body><audio src="/clip.mp3"></audio><p>News.</p></body></html>`, { headers: { "content-type": "text/html" } });
      return null;
    });
    assert.equal(await looksLikeEpisode("https://show.example.com/ep/7", { fetchImpl, lookup }), true);
    assert.equal(await looksLikeEpisode("https://show.example.com/feed", { fetchImpl, lookup }), true);
    assert.equal(await looksLikeEpisode("https://news.example.com/story", { fetchImpl, lookup }), false);
    assert.equal(await looksLikeEpisode("https://missing.example.com/", { fetchImpl, lookup }), false);
  });

  it("refuses audio too long to finish before spending on it", async () => {
    const { fetchImpl, calls } = fake(() => null);
    const audio = new Uint8Array(60 * 1024 * 1024);
    audio.set([0x49, 0x44, 0x33]);
    await assert.rejects(transcribeBytes(audio, "long.mp3", "audio/mpeg", { fetchImpl, deadline: Date.now() + 60_000 }), /too long to transcribe here/);
    assert.equal(calls.length, 0);
  });
});
