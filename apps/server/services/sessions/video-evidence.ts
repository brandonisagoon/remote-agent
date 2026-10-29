import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** The exact phone-compatible file a video capture is published as. Retries
 * upload these validated bytes; they never re-encode under the same request. */
export const PreparedVideo = z.object({
  version: z.literal(1), name: z.string(), contentType: z.literal("video/mp4"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number(), transform: z.enum(["none", "remux", "transcode"]),
});
export type PreparedVideo = z.infer<typeof PreparedVideo>;

const Probe = z.object({
  streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional(), pix_fmt: z.string().optional(), width: z.number().optional(), height: z.number().optional() })),
  format: z.object({ format_name: z.string(), duration: z.string().optional() }),
});
type Probe = z.infer<typeof Probe>;

export interface VideoOptions {
  maxBytes: number;
  which?: (tool: string) => string | null;
  timeoutMs?: { probe: number; decode: number; convert: number };
}
const TIMEOUTS = { probe: 60_000, decode: 180_000, convert: 600_000 };
const OUTPUT_LIMIT = 1024 * 1024;
const DURATION_TOLERANCE = 0.5;

/** Bounded tool run: time, captured output and (for conversion) the written
 * file size are capped. Any error-level diagnostic fails, because ffmpeg exits
 * 0 for inputs that end prematurely. */
async function run(tool: string, args: string[], options: VideoOptions, timeoutMs: number, watch?: string): Promise<string> {
  const binary = (options.which ?? Bun.which)(tool);
  if (!binary) throw new Error(`${tool} is not installed on the server host; install ffmpeg (for example brew install ffmpeg) and retry`);
  const child = Bun.spawn([binary, ...(tool === "ffmpeg" ? ["-nostdin"] : []), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let failure: string | undefined;
  const stop = (reason: string) => { failure ??= reason; child.kill("SIGKILL"); };
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = stream.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      total += read.value.byteLength;
      if (total > OUTPUT_LIMIT) stop(`${tool} produced more than 1 MiB of diagnostics`);
      else chunks.push(read.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const timer = setTimeout(() => stop(`${tool} timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
  const watcher = watch ? setInterval(() => {
    stat(watch).then((file) => { if (file.size > options.maxBytes) stop(`converted video exceeds ${options.maxBytes} bytes; record a shorter or smaller capture`); }, () => undefined);
  }, 100) : undefined;
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
    if (failure) throw new Error(failure);
    if (code !== 0 || stderr.trim()) throw new Error(`${tool} reported: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 600) || `exit ${code}`}`);
    return stdout;
  } finally { clearTimeout(timer); clearInterval(watcher); }
}

async function probe(file: string, options: VideoOptions): Promise<Probe> {
  const output = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height:format=format_name,duration", "-of", "json", file], options, (options.timeoutMs ?? TIMEOUTS).probe);
  return Probe.parse(JSON.parse(output));
}

/** Top-level ISO BMFF boxes; a short or overrunning box is a partial file. */
function boxes(bytes: Uint8Array): string[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: string[] = [];
  for (let offset = 0; offset < view.length;) {
    if (offset + 8 > view.length) throw new Error("MP4 ends inside a box header");
    let size = view.readUInt32BE(offset);
    if (size === 1) size = offset + 16 <= view.length ? Number(view.readBigUInt64BE(offset + 8)) : 0;
    else if (size === 0) size = view.length - offset;
    if (size < 8 || offset + size > view.length) throw new Error("MP4 box structure is truncated");
    found.push(view.toString("latin1", offset + 4, offset + 8));
    offset += size;
  }
  return found;
}

function streams(info: Probe) {
  const video = info.streams.filter((stream) => stream.codec_type === "video");
  const audio = info.streams.filter((stream) => stream.codec_type === "audio");
  const videoOk = video[0]?.codec_name === "h264" && video[0].pix_fmt === "yuv420p" && video[0].width! % 2 === 0 && video[0].height! % 2 === 0;
  return { video, audio, videoOk, audioOk: !audio.length || audio[0]!.codec_name === "aac", extra: info.streams.length - video.length - audio.length };
}

/** Problems that prevent publishing these exact bytes on a phone: MP4 brand,
 * moov-before-mdat fast start, single H.264 8-bit 4:2:0 video, optional AAC. */
function incompatibility(bytes: Uint8Array, info: Probe): string | undefined {
  if (!info.format.format_name.split(",").includes("mp4")) return "not an MP4 container";
  const order = boxes(bytes);
  const { video, audio, videoOk, audioOk, extra } = streams(info);
  if (order[0] !== "ftyp") return "not an MP4 container";
  if (Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "qt  ") return "QuickTime brand";
  if (!order.includes("moov") || !order.includes("mdat") || order.indexOf("moov") > order.indexOf("mdat")) return "no fast-start metadata";
  if (video.length !== 1 || !videoOk) return "video is not one H.264 8-bit 4:2:0 stream with even dimensions";
  if (audio.length > 1 || !audioOk || extra) return "audio is not a single AAC stream";
  return undefined;
}

const duration = (info: Probe) => Number(info.format.duration);

async function validate(file: string, bytes: Uint8Array, options: VideoOptions, expectedDuration?: number) {
  if (!bytes.byteLength || bytes.byteLength > options.maxBytes) throw new Error(`converted video must be nonempty and at most ${options.maxBytes} bytes`);
  const info = await probe(file, options);
  const problem = incompatibility(bytes, info);
  if (problem) throw new Error(`converted output is not phone-compatible (${problem})`);
  if (expectedDuration !== undefined && !(Math.abs(duration(info) - expectedDuration) <= DURATION_TOLERANCE)) {
    throw new Error(`converted output lasts ${info.format.duration ?? "unknown"}s instead of ${expectedDuration}s; it is incomplete`);
  }
  // Decode every frame of every stream; this catches truncated media data that
  // still has valid headers.
  await run("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-map", "0", "-f", "null", "-"], options, (options.timeoutMs ?? TIMEOUTS).decode);
}

function conversion(source: string, output: string, info: Probe, options: VideoOptions): { transform: PreparedVideo["transform"]; args: string[] } {
  const { videoOk, audioOk } = streams(info);
  const video = videoOk ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p"];
  const audio = audioOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k", "-ac", "2"];
  return {
    transform: videoOk && audioOk ? "remux" : "transcode",
    args: ["-v", "error", "-xerror", "-i", source, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", ...video, ...audio, "-movflags", "+faststart", "-fs", String(options.maxBytes), "-f", "mp4", output],
  };
}

/** Prepare a digested capture inside `directory`, a private cache owned by one
 * update request. The input bytes are copied first so the conversion matches
 * the digest. A compatible MP4 keeps its exact bytes. Otherwise the output is
 * fully validated in a temporary file before it is finalized by digest. */
export async function prepareVideoEvidence(capture: { bytes: Uint8Array; title: string; name: string }, directory: string, options: VideoOptions): Promise<PreparedVideo> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(path.join(directory, "prepare-"));
  const name = `${path.basename(capture.name, path.extname(capture.name)) || "recording"}.mp4`;
  try {
    const source = path.join(work, "source");
    const output = path.join(work, "prepared.mp4");
    await writeFile(source, capture.bytes, { flag: "wx", mode: 0o600 });
    let info: Probe;
    try { info = await probe(source, options); } catch (error) { throw new Error(`the capture could not be read (${(error as Error).message})`); }
    if (!streams(info).video.length) throw new Error("the capture has no video stream");
    const sha256 = createHash("sha256").update(capture.bytes).digest("hex");
    if (!incompatibility(capture.bytes, info)) {
      await validate(source, capture.bytes, options);
      return { version: 1, name, contentType: "video/mp4", sha256, size: capture.bytes.byteLength, transform: "none" };
    }
    const expected = duration(info);
    if (!Number.isFinite(expected) || expected <= 0) throw new Error("the capture has no readable duration; stop the recording cleanly and capture it again");
    const plan = conversion(source, output, info, options);
    await run("ffmpeg", plan.args, options, (options.timeoutMs ?? TIMEOUTS).convert, output);
    const bytes = await Bun.file(output).bytes();
    await validate(output, bytes, options, expected);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await rename(output, path.join(directory, `${digest}.mp4`));
    return { version: 1, name, contentType: "video/mp4", sha256: digest, size: bytes.byteLength, transform: plan.transform };
  } catch (error) {
    throw new Error(`Could not prepare video evidence '${capture.title}' as phone-compatible MP4: ${(error as Error).message}. This attempt made no new upload, comment or status change; fix or re-record the capture and retry.`);
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function preparedVideoPath(directory: string, prepared: PreparedVideo): string {
  return path.join(directory, `${PreparedVideo.parse(prepared).sha256}.mp4`);
}
