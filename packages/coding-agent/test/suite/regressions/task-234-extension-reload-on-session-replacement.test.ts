import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// TASK-234: a fresh resource loader must not reuse the previous session's factory.
describe("extension source on in-process session replacement", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	it.each(
		(["new", "resume", "fork-root", "fork-branch", "fork-memory", "import"] as const).flatMap((operation) =>
			(["entry", "helper"] as const).map((editedFile) => ({ operation, editedFile })),
		),
	)(
		"loads the edited installed package $editedFile before session_start on $operation",
		async ({ operation, editedFile }) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-task-234-"));
			cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
			const agentDir = join(cwd, "agent");
			const packageDir = join(cwd, "node_modules", "fixture-extension");
			mkdirSync(packageDir, { recursive: true });
			mkdirSync(agentDir);
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({
					name: "fixture-extension",
					version: "1.0.0",
					type: "module",
					pi: { extensions: ["./index.ts"] },
				}),
			);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
			const marker = `__task234_${Math.random().toString(36).slice(2)}`;
			const observations = globalThis as unknown as Record<string, string[]>;
			observations[marker] = [];
			cleanups.push(() => {
				delete observations[marker];
			});
			const entryPath = join(packageDir, "index.ts");
			const helperPath = join(packageDir, "helper.ts");
			const helperSource = (version?: string) =>
				`export function observe(version, reason) { globalThis[${JSON.stringify(marker)}].push(${version ? JSON.stringify(version) : "version"} + ":" + reason); }`;
			writeFileSync(helperPath, helperSource());
			const source = (version: string) => `import { observe } from "./helper.ts";
export default function(pi) { pi.on("session_start", event => observe(${JSON.stringify(version)}, event.reason)); }`;
			writeFileSync(entryPath, source("v1"));

			const faux = registerFauxProvider({ models: [{ id: "fixture-model", reasoning: false }] });
			cleanups.push(() => faux.unregister());
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "fixture-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(agentDir, "models.json"),
			});
			const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					modelRuntime,
					resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
				});
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: faux.getModel(),
					})),
					services,
					diagnostics: services.diagnostics,
				};
			};
			const sessionDir = join(cwd, "sessions");
			const runtime = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir,
				sessionManager:
					operation === "fork-memory" ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, sessionDir),
			});
			cleanups.push(() => runtime.dispose());
			runtime.setRebindSession(async (session) => {
				await session.bindExtensions({});
			});
			await runtime.session.bindExtensions({});
			expect(observations[marker]).toEqual(["v1:startup"]);
			if (operation === "new") {
				const originalSession = runtime.session;
				await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
				await expect(runtime.importFromJsonl(join(cwd, "missing.jsonl"))).rejects.toThrow("File not found");
				expect(runtime.session).toBe(originalSession);
				expect(observations[marker]).toEqual(["v1:startup"]);
			}

			// Change only one file: cache invalidation must refresh imported helpers too.
			if (editedFile === "entry") {
				writeFileSync(entryPath, source("v2"));
			} else {
				writeFileSync(helperPath, helperSource("v2"));
			}
			let reason = "fork";
			switch (operation) {
				case "new":
					reason = "new";
					expect(await runtime.newSession()).toEqual({ cancelled: false });
					break;
				case "resume":
				case "import": {
					reason = "resume";
					const targetDir = join(cwd, "target");
					const target = SessionManager.create(cwd, targetDir);
					target.appendMessage({ role: "user", content: "saved target", timestamp: Date.now() });
					target.appendMessage(fauxAssistantMessage("saved response"));
					const targetFile = target.getSessionFile();
					if (!targetFile) throw new Error("Missing target session file");
					expect(
						await (operation === "resume"
							? runtime.switchSession(targetFile)
							: runtime.importFromJsonl(targetFile)),
					).toEqual({ cancelled: false });
					expect(runtime.session.messages[0]).toMatchObject({ role: "user", content: "saved target" });
					break;
				}
				default: {
					const entryId = runtime.session.sessionManager.appendMessage({
						role: "user",
						content: "fork target",
						timestamp: Date.now(),
					});
					runtime.session.sessionManager.appendMessage(fauxAssistantMessage("saved response"));
					expect(
						(await runtime.fork(entryId, { position: operation === "fork-root" ? "before" : "at" })).cancelled,
					).toBe(false);
				}
			}
			// Rebinding runs session_start inside the replacement, not via a later /reload.
			expect(observations[marker]).toEqual(["v1:startup", `v2:${reason}`]);
			expect(readFileSync(editedFile === "entry" ? helperPath : entryPath, "utf8")).toBe(
				editedFile === "entry" ? helperSource() : source("v1"),
			);
		},
	);
});
