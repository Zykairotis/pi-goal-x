import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprintWorkspace } from "../workspace.ts";

test("approved file fingerprint notices content and missing-file changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "ice-goal-evidence-"));
	try {
		const missing = await fingerprintWorkspace(root, ["evidence.txt"]);
		await writeFile(join(root, "evidence.txt"), "first");
		const first = await fingerprintWorkspace(root, ["evidence.txt"]);
		assert.notEqual(first, missing);
		assert.equal(await fingerprintWorkspace(root, ["evidence.txt"]), first);
		await writeFile(join(root, "evidence.txt"), "second");
		assert.notEqual(await fingerprintWorkspace(root, ["evidence.txt"]), first);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fingerprint rejects traversal, secret paths, directories and symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "ice-goal-evidence-"));
	try {
		await writeFile(join(root, "source.txt"), "source");
		await mkdir(join(root, "directory"));
		await symlink(join(root, "source.txt"), join(root, "alias"));
		for (const path of [
			"../source.txt",
			"/tmp/secret",
			"C:\\secret",
			"source.txt/..",
			".env",
			".ice/auth.json",
			"alias",
			"directory",
		]) {
			await assert.rejects(fingerprintWorkspace(root, [path]));
		}
		await assert.rejects(fingerprintWorkspace(root, []));
		await assert.rejects(
			fingerprintWorkspace(
				root,
				Array.from({ length: 51 }, (_, i) => `file-${i}`),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
