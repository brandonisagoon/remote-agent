import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareVideoEvidence, preparedVideoPath, type VideoOptions } from "./video-evidence.ts";

// Real ffmpeg/ffprobe fixtures. Outside CI, a host without the media tools
// the server needs for video evidence reports these tests as skipped.
const ffmpeg = Bun.which("ffmpeg");
const tools = Boolean(ffmpeg && Bun.which("ffprobe"));
// CI installs ffmpeg, so a missing tool fails there instead of skipping.
const media = process.env.CI ? test : test.skipIf(!tools);
if (process.env.CI) test("CI provides ffmpeg and ffprobe for real-media tests", () => { expect(tools).toBeTrue(); });
const MAX = 50 * 1024 * 1024;
const MEDIA_TIMEOUT = 60_000;
let directory: string;
const fixtures: Record<string, Uint8Array> = {};

function encode(name: string, args: string[]) {
  const file = path.join(directory, name);
  const result = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", ...args, file], { stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return file;
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "video-evidence-"));
  if (!ffmpeg) return;
  const video = (size: string, seconds = 4) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=5:duration=${seconds}`];
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=4"];
  const files = {
    webm: encode("flow.webm", [...video("390x844"), ...tone, "-c:v", "libvpx", "-b:v", "400k", "-c:a", "libopus", "-shortest"]),
    silentWebm: encode("silent.webm", [...video("390x844"), "-c:v", "libvpx"]),
    // testsrc2 rounds odd sizes; crop after converting to 4:4:4 keeps them odd.
    odd444: encode("odd.mp4", [...video("400x900"), "-vf", "format=yuv444p,crop=391:845", "-c:v", "libx264", "-pix_fmt", "yuv444p"]),
    tenBit: encode("ten.mp4", [...video("390x844"), ...tone, "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-c:a", "aac", "-shortest"]),
    compatible: encode("ready.mp4", [...video("390x844"), ...tone, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart"]),
    slowStart: encode("slow.mp4", [...video("390x844"), ...tone, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]),
    audioOnly: encode("audio.webm", [...tone, "-c:a", "libopus"]),
  };
  for (const [key, file] of Object.entries(files)) fixtures[key] = await Bun.file(file).bytes();
  const truncate = (bytes: Uint8Array) => bytes.slice(0, Math.floor(bytes.byteLength * 0.6));
  fixtures.truncatedWebm = truncate(fixtures.webm!);
  fixtures.truncatedMp4 = truncate(fixtures.compatible!);
  // Damage spread through the media data. A single small overwrite inside
  // entropy-coded payload can decode without any reported error.
  const corrupt = Buffer.from(fixtures.compatible!);
  for (let offset = corrupt.indexOf("mdat") + 4000; offset < corrupt.length - 200; offset += 8192) corrupt.fill(0xaa, offset, offset + 200);
  fixtures.corruptMp4 = corrupt;
}, MEDIA_TIMEOUT);
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

let caches = 0;
const cache = () => path.join(directory, `cache-${++caches}`);
const options: VideoOptions = { maxBytes: MAX };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function inspect(file: string) {
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height:format=format_name,duration", "-of", "json", file]);
  const decode = Bun.spawnSync([ffmpeg!, "-v", "error", "-xerror", "-i", file, "-map", "0", "-f", "null", "-"]);
  const bytes = await Bun.file(file).bytes();
  const order: string[] = [];
  const view = Buffer.from(bytes);
  for (let offset = 0; offset + 8 <= view.length; offset += view.readUInt32BE(offset)) order.push(view.toString("latin1", offset + 4, offset + 8));
  return { ...JSON.parse(probe.stdout.toString()), decoded: decode.exitCode === 0 && !decode.stderr.length, boxes: order };
}

async function fakeTool(name: string, script: string) {
  const file = path.join(directory, `${name}-${++caches}`);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o700);
  return file;
}

media("WebM and incompatible MP4s become validated fast-start H.264 4:2:0 MP4 with AAC only when audio exists", async () => {
  for (const [key, expected] of [["webm", { audio: true, size: [390, 844] }], ["silentWebm", { audio: false, size: [390, 844] }], ["odd444", { audio: false, size: [392, 846] }], ["tenBit", { audio: true, size: [390, 844] }]] as const) {
    const root = cache();
    const prepared = await prepareVideoEvidence({ bytes: fixtures[key]!, title: key, name: `${key}.webm` }, root, options);
    expect(prepared).toMatchObject({ version: 1, name: `${key}.mp4`, contentType: "video/mp4", transform: "transcode" });
    const file = preparedVideoPath(root, prepared);
    const bytes = await Bun.file(file).bytes();
    expect(sha256(bytes)).toBe(prepared.sha256);
    expect(bytes.byteLength).toBe(prepared.size);
    const result = await inspect(file);
    expect(result.decoded).toBeTrue();
    expect(result.boxes.indexOf("moov")).toBeLessThan(result.boxes.indexOf("mdat"));
    expect(result.format.format_name).toContain("mp4");
    expect(Math.abs(Number(result.format.duration) - 4)).toBeLessThan(0.5);
    expect(result.streams.filter((stream: { codec_type: string }) => stream.codec_type === "video")).toEqual([{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: expected.size[0], height: expected.size[1] }]);
    expect(result.streams.filter((stream: { codec_type: string }) => stream.codec_type === "audio").map((stream: { codec_name: string }) => stream.codec_name)).toEqual(expected.audio ? ["aac"] : []);
    expect(await readdir(root)).toEqual([`${prepared.sha256}.mp4`]);
  }
}, MEDIA_TIMEOUT);

media("an already compatible MP4 keeps its exact bytes; a compatible stream without fast start is only remuxed", async () => {
  const root = cache();
  const kept = await prepareVideoEvidence({ bytes: fixtures.compatible!, title: "Ready", name: "ready.mp4" }, root, options);
  expect(kept).toEqual({ version: 1, name: "ready.mp4", contentType: "video/mp4", sha256: sha256(fixtures.compatible!), size: fixtures.compatible!.byteLength, transform: "none" });
  expect(await readdir(root)).toEqual([]);
  const remuxed = await prepareVideoEvidence({ bytes: fixtures.slowStart!, title: "Slow", name: "slow.MP4" }, root, options);
  expect(remuxed).toMatchObject({ name: "slow.mp4", transform: "remux" });
  const result = await inspect(preparedVideoPath(root, remuxed));
  expect(result.decoded).toBeTrue();
  expect(result.boxes.slice(0, 2)).toEqual(["ftyp", "moov"]);
  // Stream copy: the same encoded video, not a fresh encode.
  const original = path.join(directory, "slow.mp4");
  const packets = (file: string) => Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=size", "-of", "csv=p=0", file]).stdout.toString();
  expect(packets(preparedVideoPath(root, remuxed))).toBe(packets(original));
}, MEDIA_TIMEOUT);

media("truncated, corrupt and video-less captures fail with actionable errors and leave no output", async () => {
  const root = cache();
  for (const [key, reason] of [["truncatedWebm", "ended prematurely"], ["truncatedMp4", "truncated"], ["corruptMp4", "reported"], ["audioOnly", "no video stream"]] as const) {
    const attempt = prepareVideoEvidence({ bytes: fixtures[key]!, title: key, name: `${key}.mp4` }, root, options);
    await expect(attempt).rejects.toThrow(`Could not prepare video evidence '${key}' as phone-compatible MP4`);
    await expect(attempt).rejects.toThrow(reason);
    await expect(attempt).rejects.toThrow("This attempt made no new upload, comment or status change");
  }
  expect(await readdir(root)).toEqual([]);
}, MEDIA_TIMEOUT);

media("missing tools, timeouts, failed, partial, short and oversized conversions are rejected without finalized output", async () => {
  const real = (tool: string) => Bun.which(tool);
  const capture = { bytes: fixtures.webm!, title: "Flow", name: "flow.webm" };
  const fakeProbeSleep = await fakeTool("ffprobe", "exec sleep 30");
  const fakeFail = await fakeTool("ffmpeg", "echo 'encoder exploded' >&2; exit 1");
  const fakePartial = await fakeTool("ffmpeg", `for last; do :; done; "${real("ffmpeg")}" "$@" || exit $?; case "$last" in *.mp4) head -c 4000 "$last" > "$last.part" && mv "$last.part" "$last";; esac`);
  const fakeShort = await fakeTool("ffmpeg", `exec "${real("ffmpeg")}" -t 1 "$@"`);
  const cases: Array<[Partial<VideoOptions>, string]> = [
    [{ which: (tool) => tool === "ffmpeg" ? null : real(tool) }, "ffmpeg is not installed on the server host"],
    [{ which: () => null }, "ffprobe is not installed"],
    [{ which: (tool) => tool === "ffprobe" ? fakeProbeSleep : real(tool), timeoutMs: { probe: 300, decode: 300, convert: 300 } }, "ffprobe timed out"],
    [{ which: (tool) => tool === "ffmpeg" ? fakeFail : real(tool) }, "ffmpeg reported: encoder exploded"],
    [{ which: (tool) => tool === "ffmpeg" ? fakePartial : real(tool) }, "partial file"],
    [{ which: (tool) => tool === "ffmpeg" ? fakeShort : real(tool) }, "it is incomplete"],
    [{ maxBytes: 20_000 }, "20000 bytes"],
  ];
  for (const [override, reason] of cases) {
    const root = cache();
    const started = Date.now();
    await expect(prepareVideoEvidence(capture, root, { ...options, ...override })).rejects.toThrow(reason);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await readdir(root)).toEqual([]);
  }
}, MEDIA_TIMEOUT);
