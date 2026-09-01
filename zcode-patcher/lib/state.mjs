import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function assertChildPath(parent, candidate) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the allowed root: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

export async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function moveFileWithExdevFallback(source, destination, options = {}) {
  const renameFile = options.renameFile ?? rename;
  const copyFileImpl = options.copyFileImpl ?? copyFile;
  const removeFile = options.removeFile ?? rm;
  try {
    await renameFile(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await copyFileImpl(source, destination);
    await removeFile(source, { force: true });
  }
}

export async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await moveFileWithExdevFallback(tempPath, statePath);
}

export function shouldAttemptPatch(state, officialHash, patchVersion) {
  return !(
    state?.status === "incompatible"
    && state?.officialHash === officialHash
    && state?.patchVersion === patchVersion
  );
}
