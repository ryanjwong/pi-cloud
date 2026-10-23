import type { RunnerFiles } from "./agent/prompt.ts";

export { buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
export { bashToolSystemPromptContribution } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
export { editToolSystemPromptContribution } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js";
export { readToolSystemPromptContribution } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
export { writeToolSystemPromptContribution } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js";
export type { Skill } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";

export const runnerFiles = (): RunnerFiles => ({ skills: () => [], project: () => [] });
