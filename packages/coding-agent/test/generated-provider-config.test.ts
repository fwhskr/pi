import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isModelType } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const dirs: string[] = [];
function fixture(owner: object, generated: object): string {
	const dir = mkdtempSync("/home/kris/.pi/agent/var/task-274-core-");
	dirs.push(dir);
	writeFileSync(join(dir, "models.json"), JSON.stringify(owner));
	writeFileSync(join(dir, "models.generated.json"), JSON.stringify(generated));
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("machine-owned provider routes", () => {
	it("merges generated routes under owner overrides without mutating either file", async () => {
		const dir = fixture(
			{ providers: { fixture: { name: "owner", modelOverrides: { "synthetic-model": { maxTokens: 42 } } } } },
			{
				providers: {
					fixture: {
						name: "generated",
						baseUrl: "http://127.0.0.1:12345",
						modelOverrides: { "other-model": { maxTokens: 7 } },
					},
				},
			},
		);
		const paths = [join(dir, "models.json"), join(dir, "models.generated.json")];
		const before = paths.map((path) => readFileSync(path, "utf8"));
		const config = await ModelConfig.load(paths[0]);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("fixture")).toEqual({
			name: "owner",
			baseUrl: "http://127.0.0.1:12345",
			modelOverrides: { "synthetic-model": { maxTokens: 42 }, "other-model": { maxTokens: 7 } },
		});
		expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
	});
	it("does not require an owner file or create one", async () => {
		const dir = fixture({ providers: {} }, { providers: { fixture: { baseUrl: "https://fixture.invalid" } } });
		rmSync(join(dir, "models.json"));
		expect((await ModelConfig.load(join(dir, "models.json"))).getProvider("fixture")?.baseUrl).toBe(
			"https://fixture.invalid",
		);
	});
	it("reports corrupt generated routes instead of silently changing their destination", async () => {
		const dir = fixture({ providers: {} }, { providers: {} });
		writeFileSync(join(dir, "models.generated.json"), "{bad");
		expect((await ModelConfig.load(join(dir, "models.json"))).getError()).toContain("models.generated.json");
	});
	it("inherits a native catalog and OAuth for aliases without a copied model list", async () => {
		const baseline = await ModelRuntime.create({
			modelsPath: null,
			credentials: AuthStorage.inMemory(),
			allowModelNetwork: false,
		});
		const source = baseline
			.getProviders()
			.find(
				(provider) =>
					provider.auth.oauth?.isSubscription && provider.getModels().some((model) => isModelType(model, "chat")),
			);
		expect(source).toBeDefined();
		const id = `${source!.id}-account-2`;
		const dir = fixture(
			{ providers: {} },
			{ providers: { [id]: { catalogProvider: source!.id, baseUrl: "http://127.0.0.1:12345" } } },
		);
		const credentials = AuthStorage.inMemory({
			[id]: {
				type: "oauth",
				access: "synthetic-access",
				refresh: "synthetic-refresh",
				expires: Date.now() + 3600000,
			},
		});
		const runtime = await ModelRuntime.create({
			modelsPath: join(dir, "models.json"),
			credentials,
			allowModelNetwork: false,
		});
		const native = runtime.getProvider(source!.id)!;
		const alias = runtime.getProvider(id)!;
		expect(alias).toBeDefined();
		expect(alias.auth.oauth).toBeDefined();
		expect(alias.getModels().map((model) => model.id)).toEqual(native.getModels().map((model) => model.id));
		expect(alias.getModels().every((model) => model.provider === id)).toBe(true);
		expect(runtime.isUsingOAuth(id)).toBe(true);
		expect(
			runtime
				.getModels()
				.filter((model) => model.provider === id)
				.every((model) => model.baseUrl === "http://127.0.0.1:12345"),
		).toBe(true);
		expect(ModelRuntime.generatedProviderConfig).toBe(true);
	});
});
