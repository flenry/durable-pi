import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { createSkillsExtension } from "../src/onboard/skills.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

const SKILL_CONTENT = [
  "---",
  "name: grill",
  "description: Help develop an idea.",
  "---",
  "# Grill guide",
  "Ask one question at a time.",
  "",
].join("\n");
const PROMPT_CONTENT = "# Brainstorm\n\nGenerate and refine ideas.\n";

async function writeCatalog(setupDir: string) {
  const grillPath = join(setupDir, "agent", "skills", "grill", "SKILL.md");
  const privatePath = join(setupDir, "agent", "skills", "private", "SKILL.md");
  const brainstormPath = join(setupDir, "agent", "prompts", "brainstorm.md");
  await Promise.all([
    mkdir(join(setupDir, "agent", "skills", "grill"), { recursive: true }),
    mkdir(join(setupDir, "agent", "skills", "private"), { recursive: true }),
    mkdir(join(setupDir, "agent", "prompts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(grillPath, SKILL_CONTENT),
    writeFile(privatePath, "---\nname: private-skill\ndescription: Hidden\n---\nDo not list me.\n"),
    writeFile(brainstormPath, PROMPT_CONTENT),
  ]);
  return { grillPath };
}

function loadedText(extension: ReturnType<typeof createSkillsExtension>, name: string): Promise<string> {
  const tool = extension.tools?.find((candidate) => candidate.name === "load_skill");
  assert.ok(tool);
  return tool.execute({ name } as never, {} as never, {} as never).then((result) =>
    (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
  );
}

async function userMessages(agent: ReturnType<DpiClient["agent"]>): Promise<string[]> {
  const entries = await agent.entries({ scope: "all", limit: 2000 });
  return entries.items
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => {
      const message = entry.model?.[0] as { content?: unknown } | undefined;
      if (typeof message?.content === "string") return message.content;
      if (Array.isArray(message?.content))
        return message.content
          .map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
          .join("");
      return "";
    });
}

async function sendAndAssert(agent: ReturnType<DpiClient["agent"]>, content: string, requestId: string, expected: string) {
  const result = await agent.send(content, "followUp", requestId, 15_000);
  assert.equal(result.status, "done");
  const messages = await userMessages(agent);
  assert.ok(messages.includes(expected), `Expected user message ${JSON.stringify(expected)}; got ${JSON.stringify(messages)}`);
  return result;
}

test("authenticated skill commands expand catalog entries once; API exposes the same filtered catalog", async () => {
  const t = await tempStore();
  const setupDir = join(t.root, "setup");
  const files = await writeCatalog(setupDir);
  const envKeys = ["DPI_ONBOARD", "DPI_MEMORY", "PI_SETUP_DIR", "DPI_SKILLS_EXCLUDE"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  let server: Awaited<ReturnType<typeof bootServer>> | undefined;
  let offServer: Awaited<ReturnType<typeof bootServer>> | undefined;
  try {
    process.env.DPI_ONBOARD = "1";
    process.env.DPI_MEMORY = "off";
    process.env.PI_SETUP_DIR = setupDir;
    process.env.DPI_SKILLS_EXCLUDE = "private-skill";
    const token = newToken();
    server = await bootServer({ home: join(t.root, "home-on"), startDirs: t.work, token });
    const client = new DpiClient(server.base, token);
    const catalog = await client.skills();
    assert.deepEqual(catalog.find((entry) => entry.name === "grill"), {
      name: "grill",
      description: "Help develop an idea.",
      kind: "skill",
    });
    assert.deepEqual(catalog.find((entry) => entry.name === "brainstorm"), {
      name: "brainstorm",
      description: "Generate and refine ideas.",
      kind: "prompt",
    });
    assert.equal(catalog.some((entry) => entry.name === "private-skill"), false, "skillsExclude filters the API catalog");
    assert.equal((await fetch(`${server.base}/v1/skills`)).status, 401, "the catalog route requires device auth");

    const session = await client.createSession({ name: "Skills", cwd: t.work, model: faux });
    const skillExtension = createSkillsExtension({ setupDir, skillsExclude: ["private-skill"] });
    const grill = await loadedText(skillExtension, "grill");
    const brainstorm = await loadedText(skillExtension, "brainstorm");
    const agent = client.agent(session.id, "main");

    await sendAndAssert(agent, "/grill x", "skill-command-plain", `${grill}\n\nUser request: x`);
    const explicit = await sendAndAssert(agent, "/skill:grill x", "skill-command-explicit", `${grill}\n\nUser request: x`);

    // Replayed requests keep the original admitted message even if the source file changes.
    await writeFile(files.grillPath, SKILL_CONTENT.replace("Ask one question at a time.", "Changed source after admission."));
    const replay = await agent.send("/skill:grill x", "followUp", "skill-command-explicit", 15_000);
    assert.equal(replay.status, "done");
    assert.equal(replay.submissionId, explicit.submissionId);
    const afterReplay = await userMessages(agent);
    assert.equal(afterReplay.filter((message) => message === `${grill}\n\nUser request: x`).length, 2);
    assert.equal(afterReplay.some((message) => message.includes("Changed source after admission.")), false);

    await sendAndAssert(agent, "/foo x", "skill-command-unknown", "/foo x");
    await sendAndAssert(agent, "Please use /grill x", "skill-command-inline", "Please use /grill x");
    await sendAndAssert(agent, "/brainstorm", "skill-command-prompt", brainstorm);
    const refreshedGrill = await loadedText(skillExtension, "grill");
    await sendAndAssert(agent, "/grill", "skill-command-no-args", refreshedGrill);
    await sendAndAssert(agent, "approve "+"a".repeat(64), "skill-command-approve", "approve "+"a".repeat(64));

    await server.stop();
    server = undefined;
    process.env.DPI_ONBOARD = "0";
    const offToken = newToken();
    offServer = await bootServer({ home: join(t.root, "home-off"), startDirs: t.work, token: offToken });
    assert.deepEqual(await new DpiClient(offServer.base, offToken).skills(), []);
  } finally {
    await server?.stop();
    await offServer?.stop();
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await t.cleanup();
  }
});

test("internal Store sends do not expand slash commands", async () => {
  const t = await tempStore();
  const setupDir = join(t.root, "setup");
  const { grillPath } = await writeCatalog(setupDir);
  const previous = new Map(["DPI_ONBOARD", "DPI_MEMORY", "PI_SETUP_DIR"].map((key) => [key, process.env[key]]));
  let store: Awaited<ReturnType<typeof t.open>> | undefined;
  try {
    process.env.DPI_ONBOARD = "1";
    process.env.DPI_MEMORY = "off";
    process.env.PI_SETUP_DIR = setupDir;
    store = await t.open();
    const session = await store.create({ name: "Internal", cwd: t.work, model: faux });
    const { h, c, row } = await store.resolveAgent(session.id, "main");
    const submission = await store.send(row.id, c, { content: "/grill x", requestId: "internal-skill-command" });
    assert.equal((await store.settled(h, submission.id as number, 15_000)).status, "done");
    assert.ok((await store.entries(c, undefined, 100)).items.some((entry) => {
      if (entry.kind !== "pi.user") return false;
      const message = entry.model?.[0] as { content?: unknown } | undefined;
      return message?.content === "/grill x";
    }));
    assert.match(await readFile(grillPath, "utf8"), /Ask one question/);
  } finally {
    await store?.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await t.cleanup();
  }
});
