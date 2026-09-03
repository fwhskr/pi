import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
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

function extensionSource(version: string, markerKey: string): string {
	return `
const version = ${JSON.stringify(version)};

export default function (pi) {
	pi.on("session_start", () => {
		const state = (globalThis[${JSON.stringify(markerKey)}] ??= []);
		state.push(version);
	});
}
`;
}

describe("regression F-121: extension reload on session start", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("loads changed extension source for the next replacement session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-f121-"));
		const agentDir = join(tempDir, "agent");
		const extensionPath = join(agentDir, "extensions", "reload.ts");
		const markerKey = `__piF121ExtensionReload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		mkdirSync(join(agentDir, "extensions"), { recursive: true });

		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		writeFileSync(extensionPath, extensionSource("v1", markerKey), "utf-8");
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					additionalExtensionPaths: [extensionPath],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			sessionManager: SessionManager.create(tempDir),
		});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		await runtime.session.bindExtensions({});
		expect((globalThis as unknown as Record<string, string[]>)[markerKey]).toEqual(["v1"]);

		writeFileSync(extensionPath, extensionSource("v2", markerKey), "utf-8");
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		expect((globalThis as unknown as Record<string, string[]>)[markerKey]).toEqual(["v1", "v2"]);
	});
});
