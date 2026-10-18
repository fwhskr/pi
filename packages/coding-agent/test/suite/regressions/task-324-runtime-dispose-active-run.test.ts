import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { AgentToolResult, ExtensionAPI } from "../../../src/index.ts";

// TASK-324: AgentSessionRuntime.dispose() (interactive quit, SIGTERM/SIGHUP, print/rpc exit) used to
// emit session_shutdown and invalidate the session while a run was still active. The in-flight
// tool_execution_end/agent_end were then dropped, agent_settled arrived late with aborted=false
// against a stale extension context, and queued follow-ups could resume the cancelled run.

const EVENT_TYPES = [
	"agent_start",
	"tool_execution_start",
	"tool_execution_end",
	"turn_end",
	"agent_end",
	"agent_settled",
	"session_shutdown",
] as const;

describe("task-324: runtime dispose while a run is active", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function setup(options?: { ignoreAbort?: boolean; extra?: (pi: ExtensionAPI, log: string[]) => void }) {
		const tempDir = join(tmpdir(), `pi-task324-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after tool"),
		]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const log: string[] = [];
		let settledAborted: boolean | undefined;
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		let releaseTool!: () => void;

		const factory = (pi: ExtensionAPI) => {
			const model = faux.getModel();
			pi.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "[REDACTED:credential]",
				api: faux.api,
				models: faux.models.map((m) => ({
					id: m.id,
					name: m.name,
					api: m.api,
					reasoning: m.reasoning,
					input: m.input,
					cost: m.cost,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
				})),
			});
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						toolStarted();
						const finish = () => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} });
						releaseTool = finish;
						if (!options?.ignoreAbort) signal?.addEventListener("abort", finish);
					}),
			});
			for (const type of EVENT_TYPES) {
				(pi as unknown as { on(t: string, h: (e: any) => void): void }).on(type, (event) => {
					if (type === "agent_settled") settledAborted = event.aborted;
					log.push(type === "session_shutdown" ? `${type}:${event.reason}` : type);
				});
			}
			options?.extra?.(pi, log);
		};

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const serviceOptions = {
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [factory],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			};
			const services = await createAgentSessionServices(serviceOptions);
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
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			releaseTool?.();
			await runtime.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		return { runtime, faux, log, toolStartedPromise, releaseTool: () => releaseTool(), getSettledAborted: () => settledAborted };
	}

	// A deadlock fails the test quickly instead of hanging until the vitest timeout.
	async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	const countOf = (log: string[], name: string) => log.filter((entry) => entry === name).length;

	it("aborts and settles the active run before session_shutdown, delivering the completion events in order", async () => {
		const { runtime, faux, log, toolStartedPromise, getSettledAborted } = await setup();
		const promptPromise = runtime.session.prompt("call block");
		await toolStartedPromise;

		await within(runtime.dispose(), 4000, "dispose");
		await within(promptPromise, 4000, "prompt");
		const callsAtDispose = faux.state.callCount;
		await new Promise((resolve) => setTimeout(resolve, 100));

		const order = log.filter((entry) => entry !== "agent_start" && entry !== "tool_execution_start");
		expect(order).toEqual(["tool_execution_end", "turn_end", "agent_end", "agent_settled", "session_shutdown:quit"]);
		expect(getSettledAborted()).toBe(true);
		// The cancelled run is not resumed after disposal.
		expect(faux.state.callCount).toBe(callsAtDispose);
		expect(log.at(-1)).toBe("session_shutdown:quit");
		// The aborted turn is persisted before shutdown.
		const roles = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message.role);
		expect(roles).toContain("toolResult");
	});

	it("disposes an idle runtime once and repeated or concurrent disposal does not deadlock", async () => {
		const { runtime, log } = await setup();
		await within(Promise.all([runtime.dispose(), runtime.dispose()]), 2000, "concurrent dispose");
		await within(runtime.dispose(), 2000, "repeated dispose");
		expect(countOf(log, "session_shutdown:quit")).toBe(1);
	});

	it("emits one shutdown for concurrent disposal during an active run", async () => {
		const { runtime, log, toolStartedPromise, getSettledAborted } = await setup();
		const promptPromise = runtime.session.prompt("call block");
		await toolStartedPromise;

		await within(Promise.all([runtime.dispose(), runtime.dispose()]), 4000, "concurrent dispose");
		await within(promptPromise, 4000, "prompt");
		expect(countOf(log, "session_shutdown:quit")).toBe(1);
		expect(log.at(-1)).toBe("session_shutdown:quit");
		expect(getSettledAborted()).toBe(true);
	});

	it("does not deadlock when a session_shutdown handler disposes again", async () => {
		let runtimeRef: AgentSessionRuntime | undefined;
		let reentrant: Promise<void> | undefined;
		const { runtime, log } = await setup({
			extra: (pi) => {
				pi.on("session_shutdown", async () => {
					reentrant = runtimeRef?.dispose();
					await reentrant;
				});
			},
		});
		runtimeRef = runtime;
		await within(runtime.dispose(), 2000, "dispose with reentrant shutdown handler");
		expect(countOf(log, "session_shutdown:quit")).toBe(1);
		expect(reentrant).toBeDefined();
	});

	it("stays bounded when the run ignores abort, and delivers no extension event after shutdown", async () => {
		const { runtime, log, toolStartedPromise, releaseTool } = await setup({ ignoreAbort: true });
		const promptPromise = runtime.session.prompt("call block");
		void promptPromise.catch(() => {});
		await toolStartedPromise;

		const started = Date.now();
		const disposeWithOptions = runtime.dispose.bind(runtime) as (options?: { settleTimeoutMs: number }) => Promise<void>;
		await within(disposeWithOptions({ settleTimeoutMs: 200 }), 4000, "bounded dispose");
		expect(Date.now() - started).toBeLessThan(3000);
		expect(log.at(-1)).toBe("session_shutdown:quit");
		const lengthAtShutdown = log.length;

		// The tool finally finishes after disposal: nothing reaches extensions any more.
		await new Promise((resolve) => setTimeout(resolve, 50));
		releaseTool();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(log.length).toBe(lengthAtShutdown);
	});
});
