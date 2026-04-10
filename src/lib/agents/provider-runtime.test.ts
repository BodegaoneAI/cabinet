import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentProvider } from "./provider-interface";
import { providerRegistry } from "./provider-registry";
import { writeProviderSettings } from "./provider-settings";
import {
  getOneShotLaunchSpec,
  getSessionLaunchSpec,
  resolveProviderId,
  runOneShotProviderPrompt,
} from "./provider-runtime";
async function createExecutableScript(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-provider-test-"));
  const scriptPath = path.join(dir, "fake-provider.sh");
  await fs.writeFile(scriptPath, source, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

function registerTestProvider(
  provider: AgentProvider,
  t: test.TestContext,
  previousDefaultProvider: string
): void {
  providerRegistry.register(provider);
  t.after(() => {
    providerRegistry.providers.delete(provider.id);
    providerRegistry.defaultProvider = previousDefaultProvider;
  });
}

test("provider runtime resolves launch specs through registered providers", async (t) => {
  const previousDefaultProvider = providerRegistry.defaultProvider;
  const originalSettings = await fs.readFile(
    path.join(process.cwd(), "data", ".agents", ".config", "providers.json"),
    "utf8"
  ).catch(() => null);
  const scriptPath = await createExecutableScript("#!/bin/sh\nprintf '%s' \"$1\"\n");
  const provider: AgentProvider = {
    id: "test-session-provider",
    name: "Test Session Provider",
    type: "cli",
    icon: "bot",
    command: "test-session-provider",
    commandCandidates: [scriptPath],
    buildOneShotInvocation(prompt: string) {
      return {
        command: this.command || "test-session-provider",
        args: [prompt],
      };
    },
    buildSessionInvocation(prompt: string | undefined) {
      return {
        command: this.command || "test-session-provider",
        args: prompt ? ["session-mode"] : [],
        initialPrompt: prompt?.trim() || undefined,
        readyStrategy: prompt ? "claude" : undefined,
      };
    },
    async isAvailable() {
      return true;
    },
    async healthCheck() {
      return {
        available: true,
        authenticated: true,
        version: "test",
      };
    },
  };

  registerTestProvider(provider, t, previousDefaultProvider);
  providerRegistry.defaultProvider = provider.id;
  await writeProviderSettings({
    defaultProvider: provider.id,
    disabledProviderIds: [],
  });
  t.after(async () => {
    const providersPath = path.join(process.cwd(), "data", ".agents", ".config", "providers.json");
    if (originalSettings === null) {
      await fs.rm(providersPath, { force: true });
      return;
    }
    await fs.writeFile(providersPath, originalSettings, "utf8");
  });

  const oneShot = getOneShotLaunchSpec({
    providerId: provider.id,
    prompt: "hello",
    workdir: process.cwd(),
  });
  assert.equal(oneShot.command, scriptPath);
  assert.deepEqual(oneShot.args, ["hello"]);

  const session = getSessionLaunchSpec({
    providerId: provider.id,
    prompt: "hello",
    workdir: process.cwd(),
  });
  assert.equal(session.command, scriptPath);
  assert.deepEqual(session.args, ["session-mode"]);
  assert.equal(session.initialPrompt, "hello");
  assert.equal(session.readyStrategy, "claude");
  assert.equal(resolveProviderId(), provider.id);
});

test("provider runtime falls back to the enabled default when the requested provider is disabled", async (t) => {
  const providersPath = path.join(process.cwd(), "data", ".agents", ".config", "providers.json");
  const originalSettings = await fs.readFile(providersPath, "utf8").catch(() => null);

  await writeProviderSettings({
    defaultProvider: "bodega-one",
    disabledProviderIds: [],
  });

  t.after(async () => {
    if (originalSettings === null) {
      await fs.rm(providersPath, { force: true });
      return;
    }
    await fs.writeFile(providersPath, originalSettings, "utf8");
  });

  assert.equal(resolveProviderId("bodega-one"), "bodega-one");
});

test("runOneShotProviderPrompt closes stdin for CLI providers", async (t) => {
  const previousDefaultProvider = providerRegistry.defaultProvider;
  const scriptPath = await createExecutableScript(
    "#!/bin/sh\ncat >/dev/null\nprintf '%s' \"$1\"\n"
  );
  const provider: AgentProvider = {
    id: "test-run-provider",
    name: "Test Run Provider",
    type: "cli",
    icon: "bot",
    command: "test-run-provider",
    commandCandidates: [scriptPath],
    buildOneShotInvocation(prompt: string) {
      return {
        command: this.command || "test-run-provider",
        args: [prompt],
      };
    },
    async isAvailable() {
      return true;
    },
    async healthCheck() {
      return {
        available: true,
        authenticated: true,
        version: "test",
      };
    },
  };

  registerTestProvider(provider, t, previousDefaultProvider);

  const output = await runOneShotProviderPrompt({
    providerId: provider.id,
    prompt: "OK",
    cwd: process.cwd(),
    timeoutMs: 1_000,
  });

  assert.equal(output, "OK");
});
