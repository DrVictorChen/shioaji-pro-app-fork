import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", pluginRoot));
const siblingDesktopRoot = join(
  dirname(dirname(repoRoot)),
  "shioaji-pro-desktop.wt",
  basename(repoRoot)
);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, pluginRoot), "utf8"));
}

async function readOptional(path) {
  const siblingPath = path.replace(/^\.\.\/\.\.\//, "");
  for (const candidate of [
    new URL(path, pluginRoot),
    join(siblingDesktopRoot, siblingPath)
  ]) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return null;
}

function toolDefinitionNames(source) {
  const start = source.indexOf("export const TOOL_DEFS");
  const end = source.indexOf("\n];", start);
  assert.notEqual(start, -1, "tools.ts must export TOOL_DEFS");
  assert.notEqual(end, -1, "tools.ts must terminate TOOL_DEFS");
  return new Set(
    [...source.slice(start, end).matchAll(/\bname:\s*['\"]([a-z][a-z0-9_]*)['\"]/g)]
      .map((match) => match[1])
  );
}

function capabilityNames(source, setName) {
  const match = source.match(
    new RegExp(`const ${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`)
  );
  assert.ok(match, `${setName} must remain a literal capability set`);
  return [...match[1].matchAll(/['\"]([a-z][a-z0-9_]*)['\"]/g)]
    .map((entry) => entry[1]);
}

test("Codex and Claude expose the same provider-neutral skill package", async () => {
  const codex = await readJson(".codex-plugin/plugin.json");
  const claude = await readJson(".claude-plugin/plugin.json");

  assert.equal(codex.name, "shioaji-pro");
  assert.equal(claude.name, codex.name);
  assert.equal(claude.version, codex.version);
  assert.equal(claude.description, codex.description);
  assert.equal(codex.skills, "./skills/");
  assert.equal(claude.skills, codex.skills);

  for (const manifest of [codex, claude]) {
    for (const executableField of ["scripts", "hooks", "mcpServers"]) {
      assert.equal(executableField in manifest, false);
    }
  }
});

test("the shared skill and required safety references are bundled", async () => {
  const files = [
    "skills/shioaji-pro/SKILL.md",
    "skills/shioaji-pro/references/MCP_TOOLS.md",
    "skills/shioaji-pro/references/CONTENT_AND_BACKTEST.md",
    "skills/shioaji-pro/references/CONTENT_AUTHORING.md",
    "skills/shioaji-pro/references/SAFETY.md",
    "skills/shioaji-pro/references/PRIVACY.md"
  ];

  for (const file of files) {
    const contents = await readFile(new URL(file, pluginRoot), "utf8");
    assert.ok(contents.trim().length > 0, `${file} must not be empty`);
  }
});

test("the shared skill routes native content and bounded backtest reads", async () => {
  const skill = await readFile(
    new URL("skills/shioaji-pro/SKILL.md", pluginRoot),
    "utf8"
  );
  const tools = await readFile(
    new URL("skills/shioaji-pro/references/MCP_TOOLS.md", pluginRoot),
    "utf8"
  );
  const content = await readFile(
    new URL("skills/shioaji-pro/references/CONTENT_AND_BACKTEST.md", pluginRoot),
    "utf8"
  );
  const authoring = await readFile(
    new URL("skills/shioaji-pro/references/CONTENT_AUTHORING.md", pluginRoot),
    "utf8"
  );

  assert.match(skill, /(?:custom|native) indicators|自訂指標/i);
  assert.match(skill, /backtest strategies|回測策略/i);
  assert.match(skill, /CONTENT_AND_BACKTEST\.md/);
  assert.match(skill, /CONTENT_AUTHORING\.md/);
  for (const tool of [
    "save_custom_indicator",
    "list_custom_indicators",
    "mount_indicator",
    "list_indicator_instances",
    "update_indicator_instance",
    "remove_indicator_instance",
    "save_strategy",
    "list_strategies",
    "get_backtest_result",
    "list_backtest_symbol_results",
    "get_backtest_trades"
  ]) {
    assert.match(tools, new RegExp(`\\b${tool}\\b`));
    assert.match(`${skill}\n${content}`, new RegExp(`\\b${tool}\\b`));
  }
  for (const contract of [
    "plot",
    "longEntry",
    "longExit",
    "shortEntry",
    "shortExit",
    "look-ahead"
  ]) {
    assert.match(authoring, new RegExp(contract, "i"));
  }
  assert.match(authoring, /bar `i \+ 1` open/i);
  assert.match(content, /maximum is\s+100/i);
  assert.match(content, /latest 500 trades per symbol/i);
  assert.match(content, /not a Portfolio Run/i);
  assert.match(content, /ephemeral/i);
});

test("documented market, account, task, indicator, and backtest names match tools.ts", async (t) => {
  const toolSource = await readOptional("../../modules/agent/lib/tools.ts");
  const capabilitySource = await readOptional(
    "../../modules/agent/lib/app-tool-contract.ts"
  );
  if (toolSource === null || capabilitySource === null) {
    t.skip("desktop overlay sources are unavailable in this checkout");
    return;
  }

  const documented = await readFile(
    new URL("skills/shioaji-pro/references/MCP_TOOLS.md", pluginRoot),
    "utf8"
  );
  const actual = toolDefinitionNames(toolSource);
  const capabilityTools = ["MARKET_READ", "ACCOUNT_READ", "TASK_MANAGE"]
    .flatMap((setName) => capabilityNames(capabilitySource, setName));
  const scopedTools = [...actual].filter((name) =>
    name.includes("indicator") || name.includes("backtest")
  );

  for (const name of new Set([...capabilityTools, ...scopedTools])) {
    assert.ok(actual.has(name), `${name} must exist in tools.ts`);
    assert.match(documented, new RegExp(`\\b${name}\\b`));
  }
});
