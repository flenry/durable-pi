import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSkillsExtension } from "../src/onboard/skills.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-onboard-skills-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSkill(setupDir: string, folder: string, content: string): Promise<string> {
  const dir = join(setupDir, "agent", "skills", folder);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, content);
  return file;
}

async function writeBrainstorm(setupDir: string, content = "# Brainstorm\n\nYou are brainstorming an idea with the user.\n"): Promise<string> {
  const file = join(setupDir, "agent", "prompts", "brainstorm.md");
  await mkdir(join(setupDir, "agent", "prompts"), { recursive: true });
  await writeFile(file, content);
  return file;
}

function getLoadTool(extension: ReturnType<typeof createSkillsExtension>) {
  const tool = extension.tools?.find((candidate) => candidate.name === "load_skill");
  assert.ok(tool, "load_skill tool should be registered");
  return tool;
}

function textOf(result: { content?: { type: string; text?: string }[] }): string {
  return result.content?.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n") ?? "";
}

test("skill index reads YAML metadata, including folded and literal multiline descriptions", async () => {
  await withTempDir(async (setupDir) => {
    await writeSkill(
      setupDir,
      "directory-name-is-not-the-id",
      [
        "---",
        "name: folded-skill",
        "description: >-",
        "  First line",
        "  folds into this line.",
        "",
        "  A second paragraph.",
        "---",
        "# Folded skill body",
      ].join("\n"),
    );
    await writeSkill(
      setupDir,
      "literal",
      [
        "---",
        "name: literal-skill",
        "description: |",
        "  Keeps line one",
        "  and line two.",
        "---",
        "# Literal skill",
      ].join("\n"),
    );
    await writeBrainstorm(setupDir);

    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const render = extension.sections?.[0].render;
    assert.ok(render);
    const index = await render({ agent: { cwd: "/repo" } } as never, {} as never);

    assert.match(index ?? "", /`folded-skill`/);
    assert.match(index ?? "", /First line folds into this line\./);
    assert.match(index ?? "", /A second paragraph\./);
    assert.match(index ?? "", /`literal-skill`/);
    assert.match(index ?? "", /Keeps line one\s+and line two\./);
    assert.doesNotMatch(index ?? "", /`directory-name-is-not-the-id`/);
    assert.match(index ?? "", /Prompts \(not skills\)/);
    assert.match(index ?? "", /`brainstorm` \(prompt\)/);
    assert.match(index ?? "", /You are brainstorming an idea with the user/);
  });
});

test("skillsExclude hides matching skill names from both the index and load tool", async () => {
  await withTempDir(async (setupDir) => {
    await writeSkill(setupDir, "excluded", "---\nname: private-skill\ndescription: Not available\n---\nsecret skill body");
    await writeSkill(setupDir, "available", "---\nname: available-skill\ndescription: Available\n---\npublic skill body");

    const extension = createSkillsExtension({ setupDir, skillsExclude: ["private-skill"] });
    const index = await extension.sections?.[0].render?.({ agent: {} } as never, {} as never);
    assert.match(index ?? "", /`available-skill`/);
    assert.doesNotMatch(index ?? "", /`private-skill`|Not available/);
    await assert.rejects(
      getLoadTool(extension).execute({ name: "private-skill" } as never, {} as never, {} as never),
      /Unknown skill or prompt/,
    );
  });
});

test("missing and empty skill directories render a useful empty catalog", async () => {
  await withTempDir(async (setupDir) => {
    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const missing = await extension.sections?.[0].render?.({ agent: {} } as never, {} as never);
    assert.match(missing ?? "", /No skills found/);
    assert.doesNotMatch(missing ?? "", /ENOENT|Error:/);

    await mkdir(join(setupDir, "agent", "skills"), { recursive: true });
    const empty = await extension.sections?.[0].render?.({ agent: {} } as never, {} as never);
    assert.match(empty ?? "", /No skills found/);
    assert.doesNotMatch(empty ?? "", /ENOENT|Error:/);
  });
});

test("malformed skill entries are reported instead of silently disappearing", async () => {
  await withTempDir(async (setupDir) => {
    await writeSkill(setupDir, "no-frontmatter", "# Missing metadata\n");
    await writeSkill(setupDir, "missing-description", "---\nname: missing-description\n---\n# Body\n");
    await writeSkill(setupDir, "bad-name", "---\nname: ../outside\ndescription: Unsafe name\n---\n# Body\n");
    await mkdir(join(setupDir, "agent", "skills", "missing-file"), { recursive: true });

    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const index = await extension.sections?.[0].render?.({ agent: {} } as never, {} as never);
    assert.match(index ?? "", /Catalog warnings/);
    assert.match(index ?? "", /no-frontmatter/);
    assert.match(index ?? "", /missing-description/);
    assert.match(index ?? "", /bad-name/);
    assert.match(index ?? "", /missing-file.*missing or unreadable SKILL\.md/);
    assert.match(index ?? "", /malformed/i);
    assert.doesNotMatch(index ?? "", /`\.\.\/outside`/);
  });
});

test("duplicate metadata names are omitted as ambiguous catalog entries", async () => {
  await withTempDir(async (setupDir) => {
    await writeSkill(setupDir, "one", "---\nname: duplicate\ndescription: First copy\n---\n# One\n");
    await writeSkill(setupDir, "two", "---\nname: duplicate\ndescription: Second copy\n---\n# Two\n");

    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const index = await extension.sections?.[0].render?.({ agent: {} } as never, {} as never);
    assert.match(index ?? "", /duplicate skill name "duplicate" appears 2 times/);
    assert.doesNotMatch(index ?? "", /`duplicate`/);
    await assert.rejects(
      getLoadTool(extension).execute({ name: "duplicate" } as never, {} as never, {} as never),
      /Unknown skill or prompt/,
    );
  });
});

test("load_skill is replay safe and returns content, canonical source, and relative-resource guidance", async () => {
  await withTempDir(async (setupDir) => {
    const file = await writeSkill(
      setupDir,
      "the-skill-folder",
      "---\nname: actual-skill-name\ndescription: A test skill\n---\nRead references/guide.md for more.\n",
    );
    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const tool = getLoadTool(extension);
    assert.equal(tool.replay, "safe");

    const result = await tool.execute({ name: "actual-skill-name" } as never, {} as never, {} as never);
    const output = textOf(result);
    assert.match(output, /Read references\/guide\.md for more\./);
    assert.match(output, /Type: skill \(SKILL\.md\)/);
    assert.ok(output.includes(`Source (verified): ${await realpath(file)}`));
    assert.match(output, /resolve.*relative to the directory containing this verified source file/i);
    assert.match(output, /referenced files explicitly; they are not loaded automatically/i);
  });
});

test("load_skill loads brainstorm as a prompt without calling it a SKILL.md", async () => {
  await withTempDir(async (setupDir) => {
    const file = await writeBrainstorm(setupDir, "# Brainstorm\n\nMake a concise brief.\n");
    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const result = await getLoadTool(extension).execute({ name: "brainstorm" } as never, {} as never, {} as never);
    const output = textOf(result);
    assert.match(output, /Type: prompt \(not a SKILL\.md\)/);
    assert.ok(output.includes(`Source (verified): ${await realpath(file)}`));
    assert.match(output, /Make a concise brief/);
  });
});

test("load_skill rejects traversal and unknown catalog names", async () => {
  await withTempDir(async (setupDir) => {
    await writeSkill(setupDir, "known", "---\nname: known\ndescription: Known\n---\n# Body\n");
    const tool = getLoadTool(createSkillsExtension({ setupDir, skillsExclude: [] }));
    await assert.rejects(tool.execute({ name: "../outside" } as never, {} as never, {} as never), /path separators|traversal/i);
    await assert.rejects(tool.execute({ name: "not-known" } as never, {} as never, {} as never), /Unknown skill or prompt/);
  });
});

test("out-of-tree symlinked skill sources are warned and cannot be loaded", async () => {
  await withTempDir(async (dir) => {
    const setupDir = join(dir, "setup");
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    const outsideFile = join(outside, "SKILL.md");
    await writeFile(outsideFile, "---\nname: escaped-skill\ndescription: Outside\n---\nprivate content\n");
    const linkedDir = join(setupDir, "agent", "skills", "linked-directory");
    await mkdir(join(setupDir, "agent", "skills"), { recursive: true });
    await symlink(outside, linkedDir, "dir");

    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const index = await extension.sections?.[0].render?.({ agent: {} } as never, {} as never);
    assert.match(index ?? "", /linked-directory/);
    assert.match(index ?? "", /outside the skills tree/i);
    await assert.rejects(
      getLoadTool(extension).execute({ name: "escaped-skill" } as never, {} as never, {} as never),
      /Unknown skill or prompt/,
    );
    assert.equal((await readFile(outsideFile, "utf8")).includes("private content"), true);
  });
});

test("a SKILL.md symlink outside the skill tree is rejected even inside a skill folder", async () => {
  await withTempDir(async (dir) => {
    const setupDir = join(dir, "setup");
    const outside = join(dir, "outside.md");
    await writeFile(outside, "---\nname: escaped-file\ndescription: Outside\n---\nprivate content\n");
    const skillDir = join(setupDir, "agent", "skills", "linked-file");
    await mkdir(skillDir, { recursive: true });
    await symlink(outside, join(skillDir, "SKILL.md"));

    const extension = createSkillsExtension({ setupDir, skillsExclude: [] });
    const index = await extension.sections?.[0].render?.({ agent: {} } as never, {} as never);
    assert.match(index ?? "", /linked-file/);
    assert.match(index ?? "", /outside the skills tree/i);
    await assert.rejects(
      getLoadTool(extension).execute({ name: "escaped-file" } as never, {} as never, {} as never),
      /Unknown skill or prompt/,
    );
  });
});
