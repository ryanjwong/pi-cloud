import type { RunnerFiles } from "./agent/prompt.ts";
import { getAgentDir, loadProjectContextFiles, loadSkills, SettingsManager } from "./internal.ts";

export {
	bashToolSystemPromptContribution,
	buildSystemPromptSections,
	editToolSystemPromptContribution,
	readToolSystemPromptContribution,
	type Skill,
	writeToolSystemPromptContribution,
} from "./internal.ts";

export const runnerFiles = (cwd: string): RunnerFiles => {
	const settings = SettingsManager.create(cwd);
	const agentDir = getAgentDir();
	return {
		agentDir,
		skills: (dir) => loadSkills({ cwd: dir, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills,
		project: (dir) => loadProjectContextFiles({ cwd: dir, agentDir }),
	};
};
