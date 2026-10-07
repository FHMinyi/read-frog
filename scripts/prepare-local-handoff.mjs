import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Local identity is configured in the gitignored .local-handoff.json.
// Chromium derives an unpacked extension ID from Base64-decoded manifest.key.
// No identity material is bundled into this reusable delivery helper.
export function extensionId(bytes) {
  return createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
}

async function exists(filename) {
  try {
    await lstat(filename)
    return true
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return false
  }
}

async function fileHashes(root, relative = "") {
  const result = {}
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    assert(!entry.isSymbolicLink(), `Unexpected symlink in build: ${name}`)
    if (entry.isDirectory()) Object.assign(result, await fileHashes(root, name))
    else {
      const bytes = await readFile(path.join(root, name))
      result[name] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      }
    }
  }
  return result
}

export async function prepareLocalHandoff(sourceRoot, timestamp = new Date().toISOString()) {
  const localConfig = JSON.parse(
    await readFile(path.join(sourceRoot, ".local-handoff.json"), "utf8"),
  )
  assert(
    typeof localConfig.key === "string" &&
      localConfig.key.length > 0 &&
      localConfig.key.length <= 100 * 1024,
    "Configure a nonempty Base64 manifest key in .local-handoff.json",
  )
  assert(
    typeof localConfig.extensionId === "string" && /^[a-p]{32}$/.test(localConfig.extensionId),
    "Configure the existing extension ID in .local-handoff.json",
  )
  const identityBytes = Buffer.from(localConfig.key, "base64")
  assert.equal(
    identityBytes.toString("base64"),
    localConfig.key,
    "Manifest key must be canonical Base64",
  )
  assert.equal(
    extensionId(identityBytes),
    localConfig.extensionId,
    "Configured key does not match the existing extension ID",
  )
  const build = path.join(sourceRoot, ".output/chrome-mv3")
  const handoff = path.resolve(sourceRoot, "../handoff")
  const destination = path.join(handoff, "chrome-mv3")
  const token = timestamp.replace(/[^0-9TZ]/g, "")
  const stage = `${destination}.staging-${token}`
  const backup = `${destination}-before-local-${token}`
  assert(!(await exists(stage)) && !(await exists(backup)), "Delivery stage/backup already exists")
  const manifest = JSON.parse(await readFile(path.join(build, "manifest.json"), "utf8"))
  assert.equal(manifest.manifest_version, 3)
  if (await exists(destination)) {
    const previous = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8"))
    for (const field of [
      "permissions",
      "host_permissions",
      "optional_permissions",
      "optional_host_permissions",
    ])
      assert.deepEqual(
        manifest[field],
        previous[field],
        `Review changed ${field} before delivering`,
      )
    if (previous.key)
      assert.equal(
        extensionId(Buffer.from(previous.key, "base64")),
        localConfig.extensionId,
        "Refusing to replace a different extension identity",
      )
  }
  const hashes = await fileHashes(build)
  const validators = []
  for (const name of Object.keys(hashes).filter((filename) => filename.endsWith(".js"))) {
    const text = await readFile(path.join(build, name), "utf8")
    assert(!text.includes("Separated phrases are not supported;"), `Outdated validator: ${name}`)
    if (text.includes("Anki needs a verified original form of this phrase.")) validators.push(name)
  }
  assert(validators.includes("content-scripts/selection.js"), "Missing selection phrase fix")
  assert(
    validators.some((name) => name.startsWith("chunks/")),
    "Missing background phrase fix",
  )
  await mkdir(handoff, { recursive: true })
  await cp(build, stage, { recursive: true, errorOnExist: true, force: false })
  assert.deepEqual(await fileHashes(stage), hashes, "Delivery copy differs from build")
  const buildId = `separated-phrases-${token}`
  manifest.key = localConfig.key
  manifest.version_name = `${manifest.version} local ${buildId}`
  await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  const deliveredHashes = await fileHashes(stage)
  const receipt = {
    buildId,
    builtAt: timestamp,
    version: manifest.version,
    versionName: manifest.version_name,
    extensionId: localConfig.extensionId,
    validators,
    sourceRoot,
    destination,
    identityMethod: "Base64 manifest.key decoding and Chromium SHA256 extension ID generation",
    identityRuntimeVerified: false,
    browserPathSwitched: false,
    backup: (await exists(destination)) ? backup : null,
    files: deliveredHashes,
  }
  await writeFile(path.join(stage, "BUILD-INFO.json"), `${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.backup) await rename(destination, backup)
  try {
    await rename(stage, destination)
  } catch (error) {
    if (receipt.backup) await rename(backup, destination)
    throw error
  }
  await writeFile(
    path.join(handoff, "LOCAL-BUILD-RECEIPT.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  )
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const receipt = await prepareLocalHandoff(sourceRoot)
  console.log(
    JSON.stringify(
      {
        destination: receipt.destination,
        backup: receipt.backup,
        extensionId: receipt.extensionId,
        versionName: receipt.versionName,
        validators: receipt.validators,
        browserPathSwitched: false,
      },
      null,
      2,
    ),
  )
}
