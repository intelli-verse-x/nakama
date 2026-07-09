export interface CopilotModel {
  id: string;
  label: string;
}

export interface CopilotSkill {
  id: string;
  label: string;
  blurb: string;
  starterPrompts: string[];
  content: string;
}

export interface StarterPrompt {
  skillId: string;
  label: string;
  prompt: string;
}

export declare const COPILOT_MODELS: CopilotModel[];
export declare const DEFAULT_COPILOT_MODEL: string;
export declare const UNREGISTERED_RPCS: string[];
export declare const COPILOT_SKILLS: CopilotSkill[];
export declare function getCopilotSkill(id: string): CopilotSkill | undefined;
export declare const STARTER_PROMPTS: StarterPrompt[];
export declare const COPILOT_SYSTEM_PROMPT: string;
