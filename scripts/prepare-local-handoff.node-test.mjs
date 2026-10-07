import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { extensionId, prepareLocalHandoff } from "./prepare-local-handoff.mjs"

const TEST_KEY = Buffer.from("synthetic-local-handoff-identity").toString("base64")
const TEST_ID = extensionId(Buffer.from(TEST_KEY, "base64"))

test("the configured identity does not change with the unpacked directory", () => {
  assert.match(TEST_ID, /^[a-p]{32}$/)
  assert.equal(extensionId(Buffer.from(TEST_KEY, "base64")), TEST_ID)
  assert.notEqual(extensionId(Buffer.from("a-different-unpacked-directory")), TEST_ID)
})

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "read-frog-handoff-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "source")
  const build = path.join(source, ".output/chrome-mv3")
  const current = path.join(root, "handoff/chrome-mv3")
  await mkdir(path.join(build, "content-scripts"), { recursive: true })
  await mkdir(path.join(build, "chunks"), { recursive: true })
  await mkdir(current, { recursive: true })
  await writeFile(
    path.join(source, ".local-handoff.json"),
    JSON.stringify({ key: TEST_KEY, extensionId: TEST_ID }),
  )
  const manifest = {
    manifest_version: 3,
    version: "1.49.3",
    permissions: ["storage"],
    host_permissions: ["*://*/*"],
  }
  await writeFile(path.join(build, "manifest.json"), JSON.stringify(manifest))
  await writeFile(path.join(current, "manifest.json"), JSON.stringify(manifest))
  await writeFile(path.join(current, "old.txt"), "preserve previous delivery")
  const fixed = 'const error = "Anki needs a verified original form of this phrase.";'
  await writeFile(path.join(build, "content-scripts/selection.js"), fixed)
  await writeFile(path.join(build, "chunks/types-test.js"), fixed)
  return { source, build, current, manifest }
}

test("delivery preserves origin, permissions and previous files and records verifiable build hashes", async (t) => {
  const f = await fixture(t)
  const r = await prepareLocalHandoff(f.source, "2026-10-06T16:49:00.000Z")
  const manifest = JSON.parse(await readFile(path.join(f.current, "manifest.json"), "utf8"))
  assert.equal(extensionId(Buffer.from(manifest.key, "base64")), TEST_ID)
  assert.deepEqual(manifest.permissions, f.manifest.permissions)
  assert.deepEqual(manifest.host_permissions, f.manifest.host_permissions)
  assert.match(manifest.version_name, /separated-phrases-20261006T164900000Z/)
  assert.equal(await readFile(path.join(r.backup, "old.txt"), "utf8"), "preserve previous delivery")
  assert.deepEqual(JSON.parse(await readFile(path.join(f.current, "BUILD-INFO.json"), "utf8")), r)
  assert.equal(r.identityRuntimeVerified, false)
  assert.equal(r.browserPathSwitched, false)
  await assert.rejects(prepareLocalHandoff(f.source, "2026-10-06T16:49:00.000Z"), /already exists/)
})

test("permission changes cannot silently replace the delivery", async (t) => {
  const f = await fixture(t)
  await writeFile(
    path.join(f.build, "manifest.json"),
    JSON.stringify({ ...f.manifest, permissions: ["storage", "debugger"] }),
  )
  await assert.rejects(prepareLocalHandoff(f.source), /Review changed permissions/)
  assert.equal(
    await readFile(path.join(f.current, "old.txt"), "utf8"),
    "preserve previous delivery",
  )
})

test("a stale content script cannot be delivered beside a fixed worker", async (t) => {
  const f = await fixture(t)
  await writeFile(
    path.join(f.build, "content-scripts/selection.js"),
    'throw Error("Separated phrases are not supported;")',
  )
  await assert.rejects(prepareLocalHandoff(f.source), /Outdated validator/)
  assert.equal(
    await readFile(path.join(f.current, "old.txt"), "utf8"),
    "preserve previous delivery",
  )
})

test("a mismatched local identity cannot replace the current delivery", async (t) => {
  const f = await fixture(t)
  await writeFile(
    path.join(f.source, ".local-handoff.json"),
    JSON.stringify({ key: TEST_KEY, extensionId: "a".repeat(32) }),
  )
  await assert.rejects(prepareLocalHandoff(f.source), /Configured key does not match/)
  assert.equal(
    await readFile(path.join(f.current, "old.txt"), "utf8"),
    "preserve previous delivery",
  )
})

test("a delivery with another manifest identity stays untouched", async (t) => {
  const f = await fixture(t)
  await writeFile(
    path.join(f.current, "manifest.json"),
    JSON.stringify({
      ...f.manifest,
      key: Buffer.from("another-synthetic-identity").toString("base64"),
    }),
  )
  await assert.rejects(
    prepareLocalHandoff(f.source),
    /Refusing to replace a different extension identity/,
  )
  assert.equal(
    await readFile(path.join(f.current, "old.txt"), "utf8"),
    "preserve previous delivery",
  )
})
