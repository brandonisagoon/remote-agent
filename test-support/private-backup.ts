import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function privateBackupFixture(root: string, taskId: string, issue: string, extended = true) {
  const files: string[] = [];
  await mkdir(root, { mode: 0o700 });
  async function file(name: string, body: string, mode = 0o600) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, name), body, { mode }); files.push(name);
    return { file: name, sha256: sha(body), bytes: Buffer.byteLength(body) };
  }
  async function component(dir: string, manifest: string, evidence = false) {
    const a = await file(`${dir}/secret.env`, "fake fixture configuration\n", evidence ? 0o600 : 0o400), b = await file(`${dir}/run.sh`, "fixture bytes, never executed\n", evidence ? 0o600 : 0o700);
    const content = `${a.sha256}  ./secret.env\n${b.sha256}  ./run.sh\n`;
    const document = await file(manifest, content);
    return { dir, manifest, manifestSha256: document.sha256, files: 2 };
  }
  const purposes: Record<string, unknown> = {};
  for (const purpose of ["development", "review"]) {
    const mysql = await file(`${purpose}/mysql.sql`, "retained SQL\n"), postgis = await file(`${purpose}/postgis.dump`, "retained spatial\n"), redis = await file(`${purpose}/redis.rdb`, "retained Redis\n");
    const object = await file(`${purpose}/objects/nested/雪 +?#.bin`, "binary-safe object fixture\0\n");
    const body = JSON.stringify({ bucket: "fixture", count: 1, bytes: object.bytes, objects: [{ key: "nested/雪 +?#.bin", size: object.bytes, sha256: object.sha256 }] });
    const doc = await file(`${purpose}/objects-manifest.json`, body);
    const runtimeConfig = await component(`${purpose}/runtime-config`, extended ? `${purpose}-runtime-config.sha256` : `${purpose}/runtime-config.sha256`);
    purposes[purpose] = { mysql, postgis, redis, objects: { count: 1, bytes: object.bytes, manifest: doc.file, manifestSha256: doc.sha256 }, runtimeConfig,
      ...(extended && purpose === "review" ? { receipt: await file("review/review-receipt.json", "{\"fixture\":true}\n") } : {}) };
  }
  const evidence = extended ? { browserEvidence: await component("evidence/browser", "evidence-browser.sha256", true), worktreeLocal: await component("evidence/local", "evidence-local.sha256", true) } : undefined;
  const bundle = extended ? await file("git/task.bundle", "retained git bytes; not a restore claim\n") : undefined;
  await file("README.md", "Ancillary material observed now, without historical provenance\n");
  const manifest = { version: 1, taskId, purposes, ...(extended ? { issue, evidence, git: { bundle: bundle!.file, sha256: bundle!.sha256, bytes: bundle!.bytes } } : {}) };
  const document = await file("MANIFEST.json", JSON.stringify(manifest));
  const selection = { format: "task-private-backup/v1" as const, root, manifests: [{ path: "MANIFEST.json", sha256: document.sha256 }] as [{ path: string; sha256: string }], taskId, issueIdentifier: issue };
  return { root, files, manifest, selection, metadata: { manifest: `MANIFEST.json (sha256 ${document.sha256})`, retention: "Retain the exact original backup" } };
}
