// ICE Goals (MIT). Hash only the user's explicitly approved evidence files; never follow symlinks.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const MAX_FILES = 50;
const MAX_BYTES = 16 * 1024 * 1024;
const PROTECTED = new Set([
	".git",
	".ice",
	".pi",
	"node_modules",
	"credentials.json",
	"auth.json",
	"oauth.json",
]);

export async function fingerprintWorkspace(
	root: string,
	files: readonly string[],
): Promise<string> {
	if (files.length < 1 || files.length > MAX_FILES)
		throw new Error("Approval must name 1–50 relevant evidence files.");
	const canonicalRoot = await realpath(root);
	const hash = createHash("sha256").update(canonicalRoot);
	let bytes = 0;
	for (const file of [...new Set(files)].sort()) {
		const parts = file.split(/[\\/]/);
		if (
			!file ||
			isAbsolute(file) ||
			/^[A-Za-z]:/.test(file) ||
			parts.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					PROTECTED.has(part) ||
					part === ".env" ||
					part.startsWith(".env."),
			)
		) {
			throw new Error(
				"Evidence paths must be relative, non-secret regular files inside the workspace.",
			);
		}
		let candidate = canonicalRoot;
		let missing = false;
		for (const part of parts) {
			candidate = join(candidate, part);
			try {
				const stat = await lstat(candidate);
				if (stat.isSymbolicLink())
					throw new Error("Symlink evidence paths are not supported.");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				missing = true;
				break;
			}
		}
		hash.update(JSON.stringify(file));
		if (missing) {
			hash.update("missing");
			continue;
		}
		const canonical = await realpath(candidate);
		const rel = relative(canonicalRoot, canonical);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new Error("Evidence escaped the approved workspace.");
		const before = await lstat(canonical);
		if (!before.isFile() || before.size > MAX_BYTES - bytes)
			throw new Error("Unsupported or oversized evidence file.");
		const handle = await open(
			canonical,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.dev !== before.dev ||
				opened.ino !== before.ino ||
				opened.size !== before.size
			)
				throw new Error("Evidence was replaced before reading.");
			const buffer = Buffer.alloc(before.size + 1);
			let length = 0;
			while (length < buffer.byteLength) {
				const read = await handle.read(
					buffer,
					length,
					buffer.byteLength - length,
					length,
				);
				if (read.bytesRead === 0) break;
				length += read.bytesRead;
			}
			if (length !== before.size)
				throw new Error("Evidence size changed during reading.");
			const content = buffer.subarray(0, length);
			bytes += content.byteLength;
			if (bytes > MAX_BYTES)
				throw new Error("Evidence exceeds the 16 MiB snapshot ceiling.");
			const after = await lstat(canonical);
			if (
				before.ino !== after.ino ||
				before.dev !== after.dev ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			) {
				throw new Error(
					"Evidence changed during snapshot; inspect before retrying.",
				);
			}
			hash.update(`${content.byteLength}:`);
			hash.update(content);
		} finally {
			await handle.close();
		}
	}
	return hash.digest("hex");
}
