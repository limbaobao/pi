import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import type * as Os from "node:os";
import { spawnSync } from "child_process";
import { arch } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureTool, getLatestVersion, type ToolStatus } from "../src/utils/tools-manager.ts";

const originalOffline = process.env.PI_OFFLINE;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof Os>();
	return {
		...actual,
		arch: vi.fn(() => "x64"),
		platform: vi.fn(() => "linux"),
	};
});

beforeEach(() => {
	vi.mocked(arch).mockReturnValue("x64");
});

afterEach(() => {
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
	vi.unstubAllGlobals();
});

function redirectResponse(location: string): Response {
	return new Response(null, { status: 302, headers: { location } });
}

describe("getLatestVersion", () => {
	it("resolves the version from the release page redirect", async () => {
		const fetchMock = vi.fn(async () => redirectResponse("https://github.com/sharkdp/fd/releases/tag/v10.4.2"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://github.com/sharkdp/fd/releases/latest",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("keeps tags without a v prefix intact", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0")),
		);

		await expect(getLatestVersion("BurntSushi/ripgrep")).resolves.toBe("15.2.0");
	});

	it("resolves relative redirect targets", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("/sharkdp/fd/releases/tag/v10.4.2")),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
	});

	it("discards the redirect response body", async () => {
		const response = new Response("<html></html>", {
			status: 302,
			headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(response.bodyUsed).toBe(true);
	});

	it("fails clearly when the endpoint does not redirect", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Failed to resolve latest sharkdp/fd release: HTTP 404 without redirect",
		);
	});

	it("fails clearly when the redirect does not point at a release tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("https://github.com/login")),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Failed to resolve latest sharkdp/fd release: unexpected redirect to https://github.com/login",
		);
	});
});

describe("ensureTool", () => {
	// Regression for https://github.com/earendil-works/pi/issues/11209.
	it.each(["fd", "rg"] as const)("does not download %s for unsupported architectures", async (tool) => {
		delete process.env.PI_OFFLINE;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		for (const architecture of ["arm", "ia32", "riscv64", "ppc64", "s390x"] as const) {
			vi.mocked(arch).mockReturnValue(architecture);
			const statuses: ToolStatus[] = [];

			await expect(ensureTool(tool, (status) => statuses.push(status))).resolves.toBeUndefined();
			expect(statuses).toEqual([
				{
					type: "warning",
					message: `Automatic download of ${tool === "rg" ? "ripgrep" : "fd"} is not supported on linux/${architecture}. Install it with your system package manager.`,
				},
			]);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps using an installed tool on ARM32", async () => {
		vi.mocked(arch).mockReturnValue("arm");
		vi.mocked(spawnSync).mockReturnValueOnce({
			pid: 1,
			output: [],
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
			status: 0,
			signal: null,
		});

		await expect(ensureTool("fd")).resolves.toBe("fd");
	});

	it("reports status through a callback without writing to the console", async () => {
		process.env.PI_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{
				type: "warning",
				message: "fd not found. Offline mode enabled, skipping download.",
			},
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});

	it.each(["x64", "arm64"] as const)("surfaces the download error cause chain on %s", async (architecture) => {
		delete process.env.PI_OFFLINE;
		vi.mocked(arch).mockReturnValue(architecture);
		const cause = new Error("connect ETIMEDOUT 140.82.113.3:443");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed", { cause });
			}),
		);
		const statuses: ToolStatus[] = [];

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{ type: "info", message: "fd not found. Downloading..." },
			{
				type: "warning",
				message: "Failed to download fd: fetch failed: connect ETIMEDOUT 140.82.113.3:443",
			},
		]);
	});
});
