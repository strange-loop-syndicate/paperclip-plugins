import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { JOB_KEY } from "./intake.ts";

const manifest: PaperclipPluginManifestV1 = {
  id: "lab.linear-intake",
  apiVersion: 1,
  version: "0.1.0",
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
    required: ["linearApiKey", "linearAgentUserId", "fallbackProjectId", "projectLeadAgentId"],
    properties: {
      linearApiKey: {
        title: "Linear API key",
        description: "Paperclip secret holding a Linear API key with read access to the teams below.",
        format: "secret-ref",
      },
      linearAgentUserId: {
        title: "Linear agent user id",
        description: "Linear user id of the agent user. Issues assigned (or delegated) to it are taken in.",
        type: "string",
      },
      assignmentField: {
        title: "Match on",
        description: "assignee = the issue's assignee is the agent user; delegate = the issue is delegated to the agent user.",
        type: "string",
        enum: ["assignee", "delegate"],
        default: "assignee",
      },
      teamKeys: {
        title: "Linear team keys",
        type: "array",
        items: { type: "string" },
        default: ["M", "KNO"],
      },
      projectMap: {
        title: "Linear project to Paperclip project",
        description: "Linear project id or name, and the Paperclip project id for its tasks.",
        type: "array",
        items: {
          type: "object",
          required: ["linearProject", "paperclipProjectId"],
          properties: {
            linearProject: { title: "Linear project id or name", type: "string" },
            paperclipProjectId: { title: "Paperclip project id", type: "string" },
          },
        },
        default: [],
      },
      fallbackProjectId: {
        title: "Fallback Paperclip project id",
        description: "Used when the Linear issue has no project, or its project is not mapped or not found.",
        type: "string",
      },
      projectLeadAgentId: {
        title: "Project Lead agent id",
        type: "string",
        default: "e18b31d8-e737-4e89-8471-697d59b65453",
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
