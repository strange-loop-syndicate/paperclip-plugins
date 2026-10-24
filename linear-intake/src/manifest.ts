import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_ASSIGNMENT_FIELD,
  DEFAULT_FALLBACK_PROJECT,
  DEFAULT_LINEAR_AGENT_USER,
  DEFAULT_PROJECT_LEAD_AGENT_ID,
  DEFAULT_TEAM_KEYS,
} from "./config.ts";
import { JOB_KEY } from "./intake.ts";

const manifest: PaperclipPluginManifestV1 = {
  id: "lab.linear-intake",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Linear Intake",
  description:
    "Every 2 minutes, finds Todo Linear issues delegated to the agent user and opens one Paperclip task per issue for the Project Lead. Reads Linear only; makes no LLM calls.",
  author: "Right2Hope lab",
  categories: ["automation", "connector"],
  capabilities: [
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "projects.read",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["linearApiKey"],
    properties: {
      linearApiKey: {
        title: "Linear API key",
        description: "Paperclip secret holding a Linear API key with read access to the teams below.",
        format: "secret-ref",
      },
      linearAgentUser: {
        title: "Linear agent user",
        description: "Name, display name or email of the Linear user that issues are delegated (or assigned) to. A Linear user id also works.",
        type: "string",
        default: DEFAULT_LINEAR_AGENT_USER,
      },
      assignmentField: {
        title: "Match on",
        description: "delegate = the issue is delegated to the agent user; assignee = the issue's assignee is the agent user.",
        type: "string",
        enum: ["delegate", "assignee"],
        default: DEFAULT_ASSIGNMENT_FIELD,
      },
      teamKeys: {
        title: "Linear team keys",
        type: "array",
        items: { type: "string" },
        default: DEFAULT_TEAM_KEYS,
      },
      fallbackProject: {
        title: "Fallback Paperclip project",
        description:
          "Project name or id. Used when the Linear issue has no project, or no Paperclip project has the Linear project's name.",
        type: "string",
        default: DEFAULT_FALLBACK_PROJECT,
      },
      projectMap: {
        title: "Project overrides",
        description:
          "Optional. Issues go to the Paperclip project with the same name as their Linear project. Add a row only where the names differ.",
        type: "array",
        items: {
          type: "object",
          // paperclipProject is not required here: rows saved before 0.2.0 hold paperclipProjectId.
          // parseConfig rejects a row that has neither.
          required: ["linearProject"],
          properties: {
            linearProject: { title: "Linear project name or id", type: "string" },
            paperclipProject: { title: "Paperclip project name or id", type: "string" },
          },
        },
        default: [],
      },
      projectLeadAgentId: {
        title: "Project Lead agent",
        description: "Paperclip agent id or name that gets the task and the wakeup.",
        type: "string",
        default: DEFAULT_PROJECT_LEAD_AGENT_ID,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEY,
      displayName: "Linear intake",
      description: "Opens a Project Lead task for each new Todo Linear issue delegated to the agent user.",
      schedule: "*/2 * * * *",
    },
  ],
};

export default manifest;
