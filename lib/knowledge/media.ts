import { htmlToText } from "@/lib/mail/text";
import { LlmError, transcribeAudio, TRANSCRIBE_MAX_BYTES } from "@/lib/llm";
import { downloadPublic, WebPageError, type Lookup } from "@/lib/web-page";

const AUDIO_MAX = 120 * 1024 * 1024;
const ROUND_MS = 45_000;
const SUPADATA_POLLS = 60;
const PIECE_BYTES = 9 * 1024 * 1024;
const PARALLEL = 3;
const PARAGRAPH_MS = 60_000;
const SUPADATA = "https://api.supadata.ai/v1";
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "GB" };

export class MediaError extends Error {}

export type MediaOptions = { fetchImpl?: typeof fetch; lookup?: Lookup; deadline?: number };
export type MediaText = { text: string; title: string | null };

const AUDIO_EXTENSION = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|mp4|mpga|webm)$/i;

function parse(raw: string) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function videoId(value: string | null | undefined) {
  return value && /^[\w-]{11}$/.test(value) ? value : null;
}

export function youtubeId(raw: string) {
  const url = parse(raw);
  if (!url) return null;
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") return videoId(url.pathname.slice(1).split("/")[0]);
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (url.pathname === "/watch") return videoId(url.searchParams.get("v"));
  return videoId(url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?]+)/)?.[1]);
}

export function isAudioUrl(raw: string) {
  const url = parse(raw);
  return Boolean(url && AUDIO_EXTENSION.test(url.pathname));
}

export function linkKind(raw: string): "youtube" | "podcast" | "link" {
  if (youtubeId(raw)) return "youtube";
  const url = parse(raw);
  if (!url) return "link";
  const host = url.hostname.replace(/^www\./, "");
  if (host === "podcasts.apple.com" || (host === "open.spotify.com" && /^\/(episode|show)\//.test(url.pathname)) || host === "overcast.fm" || host === "pca.st") return "podcast";
  return isAudioUrl(raw) ? "podcast" : "link";
}

function clock(ms: number) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function timedText(segments: { startMs: number; text: string }[]) {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let started = -1;
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (started < 0 || segment.startMs - started >= PARAGRAPH_MS) {
      if (current.length) paragraphs.push(current.join(" "));
      current = [`[${clock(segment.startMs)}]`];
      started = segment.startMs;
    }
    current.push(text);
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n\n");
}

function supadataKey() {
  return process.env.SUPADATA_API_KEY?.trim() || null;
}

async function supadata(target: string, options: MediaOptions) {
  const key = supadataKey();
  if (!key) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { "x-api-key": key };
  const response = await fetchImpl(`${SUPADATA}/transcript?url=${encodeURIComponent(target)}&text=false`, { headers, signal: AbortSignal.timeout(90_000) });
  let body = (await response.json().catch(() => null)) as { content?: unknown; jobId?: string; status?: string; message?: string } | null;
  if (response.status === 202 && body?.jobId) {
    const jobId = body.jobId;
    body = null;
    for (let poll = 0; poll < SUPADATA_POLLS && (!options.deadline || Date.now() < options.deadline - 15_000); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const poll = await fetchImpl(`${SUPADATA}/transcript/${encodeURIComponent(jobId)}`, { headers, signal: AbortSignal.timeout(20_000) });
      const job = (await poll.json().catch(() => null)) as { status?: string; content?: unknown } | null;
      if (job?.status === "completed") {
        body = job;
        break;
      }
      if (job?.status === "failed") throw new MediaError("The transcript service couldn't transcribe it.");
    }
    if (!body) throw new MediaError("The transcript took too long. Try again.");
  } else if (!response.ok) {
    throw new MediaError(response.status === 206 || response.status === 404 ? "There's no transcript for that." : `The transcript service answered ${response.status}.`);
  }
  const content = body?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  return timedText(content.map((chunk: { text?: unknown; offset?: unknown }) => ({ startMs: Number(chunk.offset) || 0, text: String(chunk.text ?? "") }))) || null;
}

export function captionSegments(raw: string) {
  const body = raw.trim();
  if (!body) return [];
  if (body.startsWith("{")) {
    const events = (JSON.parse(body) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] }).events ?? [];
    return events.map((event) => ({ startMs: event.tStartMs ?? 0, text: (event.segs ?? []).map((seg) => seg.utf8 ?? "").join("") }));
  }
  const paragraphs = [...body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)].map((match) => ({
    startMs: Number(attribute(match[1], "t")) || 0,
    text: htmlToText(match[2].replace(/<[^>]+>/g, "")),
  }));
  if (paragraphs.length) return paragraphs;
  return [...body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match) => ({
    startMs: Math.round((Number(attribute(match[1], "start")) || 0) * 1000),
    text: htmlToText(htmlToText(match[2])),
  }));
}

type CaptionTrack = { baseUrl?: string; languageCode?: string; kind?: string; name?: { runs?: { text?: string }[] } };

async function youtubeCaptions(id: string, options: MediaOptions) {
  const player = await downloadPublic("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    fetchImpl: options.fetchImpl,
    lookup: options.lookup,
    method: "POST",
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId: id }),
    headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip" },
    accept: "application/json",
    maxBytes: 5_000_000,
    timeoutMs: 20_000,
  });
  const data = JSON.parse(new TextDecoder().decode(player.bytes)) as {
    playabilityStatus?: { status?: string };
    videoDetails?: { title?: string; author?: string; shortDescription?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  };
  const details = data.videoDetails ?? {};
  const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const english = (track: CaptionTrack) => (track.languageCode ?? "").toLowerCase().startsWith("en");
  const track =
    tracks.find((item) => english(item) && item.kind !== "asr") ??
    tracks.find((item) => english(item)) ??
    tracks.find((item) => item.kind !== "asr") ??
    tracks[0];
  let text = "";
  if (track?.baseUrl) {
    const captions = await downloadPublic(track.baseUrl, {
      fetchImpl: options.fetchImpl,
      lookup: options.lookup,
      accept: "application/json, text/xml",
      maxBytes: 10_000_000,
      timeoutMs: 20_000,
    });
    text = timedText(captionSegments(new TextDecoder().decode(captions.bytes)));
  }
  return { title: details.title ?? null, author: details.author ?? null, description: details.shortDescription ?? null, text, status: data.playabilityStatus?.status ?? null };
}

async function oembedTitle(target: string, options: MediaOptions) {
  try {
    const response = await downloadPublic(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`, {
      fetchImpl: options.fetchImpl,
      lookup: options.lookup,
      accept: "application/json",
      maxBytes: 100_000,
      timeoutMs: 10_000,
    });
    const body = JSON.parse(new TextDecoder().decode(response.bytes)) as { title?: string; author_name?: string };
    return { title: body.title ?? null, author: body.author_name ?? null };
  } catch {
    return { title: null, author: null };
  }
}

function withHeader(parts: { title: string | null; author: string | null; description?: string | null }, transcript: string) {
  const lines = [parts.author ? `Channel: ${parts.author}` : null, parts.description?.trim() ? `Description:\n${parts.description.trim().slice(0, 4000)}` : null].filter(Boolean);
  return [...lines, `Transcript:\n${transcript}`].join("\n\n");
}

export async function readYouTube(target: string, options: MediaOptions): Promise<MediaText> {
  const id = youtubeId(target);
  if (!id) throw new MediaError("That isn't a YouTube video link.");
  const watch = `https://www.youtube.com/watch?v=${id}`;
  let direct: Awaited<ReturnType<typeof youtubeCaptions>> | null = null;
  try {
    direct = await youtubeCaptions(id, options);
  } catch (error) {
    if (!(error instanceof WebPageError)) console.error("YouTube captions failed", error);
  }
  if (direct?.text) return { title: direct.title, text: withHeader(direct, direct.text) };
  const named = direct?.title ? { title: direct.title, author: direct.author } : await oembedTitle(watch, options);
  const fallback = await supadata(watch, options);
  if (fallback) return { title: named.title, text: withHeader({ ...named, description: direct?.description }, fallback) };
  if (direct?.status && direct.status !== "OK" && direct.status !== "LOGIN_REQUIRED") throw new MediaError("YouTube says that video isn't available.");
  throw new MediaError(
    supadataKey()
      ? "That video has no captions to read."
      : "YouTube didn't share this video's captions with Orbit. Set SUPADATA_API_KEY in Vercel to read any video, or upload the transcript as a file.",
  );
}

type Episode = { title: string | null; show: string | null; audioUrl: string; feedUrl: string | null; description: string | null };

function attribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1]?.replace(/&amp;/g, "&") ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1]?.replace(/&amp;/g, "&") ?? null;
}

function xmlText(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1];
  if (!match) return null;
  const inner = match.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return htmlToText(inner).replace(/\s+\n/g, "\n").trim() || null;
}

function sameAudio(a: string, b: string) {
  const strip = (value: string) => {
    const url = parse(value);
    return url ? `${url.hostname}${url.pathname}`.toLowerCase() : value.toLowerCase();
  };
  const left = strip(a);
  const right = strip(b);
  return left === right || left.endsWith(right.split("/").slice(-2).join("/")) || right.endsWith(left.split("/").slice(-2).join("/"));
}

function normalTitle(value: string | null) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function text(raw: string, options: MediaOptions, maxBytes: number) {
  const response = await downloadPublic(raw, { fetchImpl: options.fetchImpl, lookup: options.lookup, maxBytes, timeoutMs: 30_000 });
  return { ...response, body: new TextDecoder().decode(response.bytes) };
}

async function appleEpisode(url: URL, options: MediaOptions): Promise<Episode> {
  const show = url.pathname.match(/\/id(\d+)/)?.[1];
  const episode = url.searchParams.get("i");
  if (!show || !episode) throw new MediaError("Use the link to one episode, not the whole show.");
  const lookup = await text(`https://itunes.apple.com/lookup?id=${show}&entity=podcastEpisode&limit=200`, options, 5_000_000);
  const results = (JSON.parse(lookup.body) as { results?: { wrapperType?: string; kind?: string; trackId?: number; trackName?: string; collectionName?: string; episodeUrl?: string; feedUrl?: string; description?: string }[] }).results ?? [];
  const match = results.find((item) => String(item.trackId) === episode && item.episodeUrl);
  if (!match?.episodeUrl) throw new MediaError("Apple only lists a show's latest 200 episodes. Paste the episode's audio file link instead.");
  const feedUrl = results.find((item) => item.feedUrl)?.feedUrl ?? match.feedUrl ?? null;
  return { title: match.trackName ?? null, show: match.collectionName ?? null, audioUrl: match.episodeUrl, feedUrl, description: match.description ?? null };
}

function latestFromFeed(xml: string, feedUrl: string): Episode {
  const item = xml.match(/<item\b[\s\S]*?<\/item>/i)?.[0];
  const enclosure = item?.match(/<enclosure\b[^>]*>/i)?.[0];
  const audioUrl = enclosure ? attribute(enclosure, "url") : null;
  if (!item || !audioUrl) throw new MediaError("That feed has no episodes with audio.");
  return { title: xmlText(item, "title"), show: xmlText(xml.replace(/<item\b[\s\S]*$/i, ""), "title"), audioUrl, feedUrl, description: xmlText(item, "description") };
}

function episodeFromPage(html: string, base: string): Episode {
  const find = (pattern: RegExp) => html.match(pattern)?.[1]?.replace(/&amp;/g, "&") ?? null;
  const audio =
    find(/<meta[^>]+property="og:audio(?::url|:secure_url)?"[^>]+content="([^"]+)"/i) ??
    find(/<audio\b[^>]*\bsrc="([^"]+)"/i) ??
    find(/<source\b[^>]*\bsrc="([^"]+)"[^>]*type="audio\//i) ??
    find(/href="([^"]+\.(?:mp3|m4a)(?:\?[^"]*)?)"/i);
  if (!audio) throw new MediaError("Orbit couldn't find the episode's audio on that page. Paste the Apple Podcasts link or the audio file link.");
  const feed = find(/<link\b[^>]*type="application\/rss\+xml"[^>]*href="([^"]+)"/i) ?? find(/<link\b[^>]*href="([^"]+)"[^>]*type="application\/rss\+xml"/i);
  return {
    title: find(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) ?? find(/<title[^>]*>([^<]*)<\/title>/i),
    show: find(/<meta[^>]+property="og:site_name"[^>]+content="([^"]*)"/i),
    audioUrl: new URL(audio, base).href,
    feedUrl: feed ? new URL(feed, base).href : null,
    description: find(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i),
  };
}

async function resolveEpisode(target: string, options: MediaOptions): Promise<Episode> {
  const url = parse(target);
  if (!url) throw new MediaError("That isn't a link Orbit can open.");
  const host = url.hostname.replace(/^www\./, "");
  if (host === "open.spotify.com") throw new MediaError("Spotify doesn't share episode audio. Paste the Apple Podcasts link or the episode's own page.");
  if (host === "podcasts.apple.com") return appleEpisode(url, options);
  if (isAudioUrl(target)) return { title: decodeURIComponent(url.pathname.split("/").pop() ?? "").replace(AUDIO_EXTENSION, "") || null, show: null, audioUrl: url.href, feedUrl: null, description: null };
  const page = await text(target, options, 15_000_000);
  if (page.contentType.startsWith("audio/")) return { title: null, show: null, audioUrl: page.url, feedUrl: null, description: null };
  if (/xml|rss/.test(page.contentType) || /^\s*(<\?xml[^>]*>\s*)?<rss\b/i.test(page.body)) return latestFromFeed(page.body, page.url);
  return episodeFromPage(page.body, page.url);
}

function cueText(raw: string) {
  const lines: string[] = [];
  let speaker: string | null = null;
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^WEBVTT/.test(trimmed) || /^\d+$/.test(trimmed) || /-->/.test(trimmed) || /^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue;
    const voice = trimmed.match(/^<v\s+([^>]+)>/i)?.[1]?.trim() ?? trimmed.match(/^([A-Z][\w .'-]{1,40}):\s/)?.[1] ?? null;
    const words = trimmed.replace(/<[^>]+>/g, "").replace(/^([A-Z][\w .'-]{1,40}):\s/, "").trim();
    if (!words) continue;
    if (voice && voice !== speaker) {
      speaker = voice;
      lines.push(`\n${voice}: ${words}`);
    } else lines.push(words);
  }
  return lines.join(" ").replace(/ \n/g, "\n\n").trim();
}

export function transcriptText(raw: string, type: string) {
  if (/json/.test(type)) {
    const body = JSON.parse(raw) as { segments?: { speaker?: string; startTime?: number; body?: string }[] };
    let speaker: string | null = null;
    const parts: string[] = [];
    for (const segment of body.segments ?? []) {
      const words = (segment.body ?? "").trim();
      if (!words) continue;
      if (segment.speaker && segment.speaker !== speaker) {
        speaker = segment.speaker;
        parts.push(`\n${speaker}: ${words}`);
      } else parts.push(words);
    }
    return parts.join(" ").replace(/ \n/g, "\n\n").trim();
  }
  if (/html/.test(type)) return htmlToText(raw).trim();
  if (/vtt|srt|subrip/.test(type)) return cueText(raw);
  return raw.trim();
}

const TRANSCRIPT_PREFERENCE = ["text/vtt", "application/x-subrip", "application/srt", "application/json", "text/html", "text/plain"];

async function feedTranscript(episode: Episode, options: MediaOptions) {
  if (!episode.feedUrl) return null;
  try {
    const feed = await text(episode.feedUrl, options, 30_000_000);
    const items = feed.body.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
    const item = items.find((entry) => {
      const enclosure = entry.match(/<enclosure\b[^>]*>/i)?.[0];
      const audio = enclosure ? attribute(enclosure, "url") : null;
      return (audio && sameAudio(audio, episode.audioUrl)) || (episode.title && normalTitle(xmlText(entry, "title")) === normalTitle(episode.title));
    });
    if (!item) return null;
    const tags = (item.match(/<podcast:transcript\b[^>]*>/gi) ?? [])
      .map((tag) => ({ url: attribute(tag, "url"), type: (attribute(tag, "type") ?? "").toLowerCase() }))
      .filter((tag): tag is { url: string; type: string } => Boolean(tag.url))
      .sort((a, b) => {
        const rank = (type: string) => (TRANSCRIPT_PREFERENCE.indexOf(type) + 1 || TRANSCRIPT_PREFERENCE.length + 1);
        return rank(a.type) - rank(b.type);
      });
    for (const tag of tags) {
      try {
        const file = await text(tag.url, options, 10_000_000);
        const words = transcriptText(file.body, tag.type || file.contentType);
        if (words.length > 200) return { text: words, description: episode.description ?? xmlText(item, "description") };
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isMp3(bytes: Uint8Array, type: string, name: string) {
  if (/mpeg|mp3/.test(type) || /\.mp3$/i.test(name)) return true;
  return (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

export function mp3Pieces(bytes: Uint8Array, size = PIECE_BYTES) {
  const pieces: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + size);
    if (end < bytes.length) {
      const limit = Math.min(bytes.length - 1, end + 8192);
      for (let index = end; index < limit; index += 1) {
        if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) {
          end = index;
          break;
        }
      }
    }
    pieces.push(bytes.subarray(start, end));
    start = end;
  }
  return pieces;
}

export async function transcribeBytes(bytes: Uint8Array, name: string, type: string, options: MediaOptions) {
  if (bytes.byteLength <= TRANSCRIBE_MAX_BYTES) return transcribeAudio(bytes, name, type, { fetchImpl: options.fetchImpl });
  if (!isMp3(bytes, type, name)) throw new MediaError("Audio over 10 MB has to be MP3 for Orbit to transcribe it.");
  const pieces = mp3Pieces(bytes);
  if (options.deadline && Date.now() + Math.ceil(pieces.length / PARALLEL) * ROUND_MS > options.deadline) {
    throw new MediaError("That audio is too long to transcribe here. Upload its transcript instead.");
  }
  const results: string[] = new Array(pieces.length).fill("");
  const stop = new AbortController();
  let next = 0;
  const worker = async () => {
    while (next < pieces.length && !stop.signal.aborted) {
      const index = next;
      next += 1;
      if (options.deadline && Date.now() > options.deadline - ROUND_MS) {
        stop.abort();
        throw new MediaError("That audio is too long to transcribe here. Upload its transcript instead.");
      }
      try {
        results[index] = await transcribeAudio(pieces[index], `part-${index + 1}.mp3`, "audio/mpeg", { fetchImpl: options.fetchImpl, signal: stop.signal });
      } catch (error) {
        stop.abort();
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, pieces.length) }, worker));
  return results.filter(Boolean).join("\n\n");
}

export async function looksLikeEpisode(target: string, options: MediaOptions) {
  if (linkKind(target) !== "link") return false;
  try {
    const page = await downloadPublic(target, { fetchImpl: options.fetchImpl, lookup: options.lookup, maxBytes: 3_000_000, timeoutMs: 12_000, accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.5" });
    if (page.contentType.startsWith("audio/")) return true;
    const head = new TextDecoder().decode(page.bytes.subarray(0, 3_000_000));
    if (/xml|rss/.test(page.contentType) || /^\s*(<\?xml[^>]*>\s*)?<rss\b/i.test(head)) return /<enclosure\b/i.test(head);
    return /<meta[^>]+property="og:audio(?::url|:secure_url)?"[^>]+content="[^"]+"/i.test(head);
  } catch {
    return false;
  }
}

export async function readPodcast(target: string, options: MediaOptions): Promise<MediaText> {
  const episode = await resolveEpisode(target, options);
  const title = [episode.title, episode.show].filter(Boolean).join(" · ") || null;
  const header = (description: string | null) =>
    [episode.show ? `Show: ${episode.show}` : null, description?.trim() ? `Episode notes:\n${htmlToText(description).trim().slice(0, 4000)}` : null].filter(Boolean).join("\n\n");
  const published = await feedTranscript(episode, options);
  if (published) return { title, text: [header(published.description), `Transcript:\n${published.text}`].filter(Boolean).join("\n\n") };
  let audio;
  try {
    audio = await downloadPublic(episode.audioUrl, { fetchImpl: options.fetchImpl, lookup: options.lookup, maxBytes: AUDIO_MAX, timeoutMs: 120_000, accept: "audio/*,*/*" });
  } catch (error) {
    throw new MediaError(error instanceof WebPageError ? `Couldn't download the episode: ${error.message}` : "Couldn't download the episode.");
  }
  if (audio.truncated) throw new MediaError("That episode is over 120 MB.");
  let transcript: string;
  try {
    transcript = await transcribeBytes(audio.bytes, decodeURIComponent(parse(audio.url)?.pathname.split("/").pop() || "episode.mp3"), audio.contentType, options);
  } catch (error) {
    if (error instanceof MediaError && supadataKey()) {
      const fallback = await supadata(episode.audioUrl, options);
      if (fallback) return { title, text: [header(episode.description), `Transcript:\n${fallback}`].filter(Boolean).join("\n\n") };
    }
    if (error instanceof LlmError) throw new MediaError("Transcribing the episode didn't work. Try again.");
    throw error;
  }
  if (!transcript.trim()) throw new MediaError("The episode had no speech to transcribe.");
  return { title, text: [header(episode.description), `Transcript:\n${transcript}`].filter(Boolean).join("\n\n") };
}
