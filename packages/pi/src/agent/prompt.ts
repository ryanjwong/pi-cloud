// Vendored from Pi (github.com/earendil-works/pi, v1.1.0), packages/coding-agent/src/experimental/durable/prompt.ts.
// MIT License, Copyright (c) 2025 Mario Zechner. Changed: imports of Pi internals go through ../internal.ts, and
// project context files are read through the execution environment, which may be a sandbox on another machine.
import type { Context } from "@earendil-works/chord";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	bashToolSystemPromptContribution,
	buildSystemPromptSections,
	editToolSystemPromptContribution,
	getAgentDir,
	loadProjectContextFiles,
	loadSkills,
	readToolSystemPromptContribution,
	type SettingsManager,
	type Skill,
	writeToolSystemPromptContribution,
} from "../internal.ts";

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
};

/** pi's context file names, in the order it looks for them in each directory. */
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

type ContextFile = { path: string; content: string };

/** The agent directory's own context file, on the runner. */
function globalContextFile(agentDir: string): ContextFile | undefined {
	for (const name of CONTEXT_FILES) {
		const path = join(agentDir, name);
		if (existsSync(path) && statSync(path).isFile()) return { path, content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") };
	}
	return undefined;
}

/**
 * The first context file of `cwd` and of each ancestor, outermost first, read from the environment the tools run in.
 * One command finds them all, so a remote sandbox costs one round trip plus one per file.
 */
async function environmentContextFiles(env: ExecutionEnv, cwd: string, context: Context): Promise<ContextFile[]> {
	const names = CONTEXT_FILES.map((name) => `'${name}'`).join(" ");
	const script = `d="$1"; while :; do for f in ${names}; do if [ -f "$d/$f" ]; then printf '%s\\n' "$d/$f"; break; fi; done; [ "$d" = / ] && break; d=$(dirname -- "$d"); done`;
	let listing = "";
	const found = await env.exec(["sh", "-c", script, "sh", cwd], { onOutput: (text, _context, info) => void (info.stream === "stdout" && (listing += text)) }, context);
	if (!found.ok || found.value.exitCode !== 0) return [];
	const files: ContextFile[] = [];
	for (const path of listing.split("\n").filter(Boolean)) {
		const content = await env.readTextFile(path, context);
		if (content.ok) files.unshift({ path: path.replace(/^\/\//, "/"), content: content.value.replace(/^\uFEFF/, "") });
	}
	return files;
}

/** pi's section order; `buildSystemPromptSections()` omits the ones without content. */
const KEYS = ["preamble", "tools", "rules", "docs", "project_context", "skills", "cwd"] as const;

/**
 * pi's system prompt as one extension: the sections of `buildSystemPromptSections()` for the request's tools and the
 * conversation's directory. Context files and skills load once per directory, like pi at startup.
 */
export function createPiPrompt(settings: SettingsManager, fallbackCwd: string) {
	type Resources = { contextFiles: ContextFile[]; skills: Skill[] };
	const resources = new Map<string, Promise<Resources>>();
	const load = (cwd: string, env: ExecutionEnv | undefined, context: Context) => {
		const key = `${env?.id ?? ""}\0${cwd}`;
		let found = resources.get(key);
		if (found === undefined) {
			const agentDir = getAgentDir();
			const skills = loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills;
			found = env === undefined
				? Promise.resolve({ contextFiles: loadProjectContextFiles({ cwd, agentDir }), skills })
				: environmentContextFiles(env, cwd, context).then((project) => {
					const global = globalContextFile(agentDir);
					return { contextFiles: [...(global === undefined ? [] : [global]), ...project], skills };
				});
			found.catch(() => resources.delete(key));
			resources.set(key, found);
		}
		return found;
	};
	// The sections of one request render from one build.
	const built = new WeakMap<PromptInput, Promise<Record<string, string>>>();
	const build = (input: PromptInput, context: Context): Promise<Record<string, string>> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input, context);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = async (input: PromptInput, context: Context): Promise<Record<string, string>> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution === undefined) continue;
			snippets[name] = contribution.snippet;
			guidelines[name] = [...contribution.guidelines];
		}
		return buildSystemPromptSections({
			cwd,
			selectedTools,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
			...(await load(cwd, input.env, context)),
		});
	};
	return defineExtension({
		name: "pi-prompt",
		// The built sections carry their own tags.
		sections: KEYS.map((key) => section(key, async (input, context) => (await build(input, context))[key], { tag: false })),
	});
}
