/** Which server reads a setting. The all-in-one server reads both. */
export type Component = "control-plane" | "runner"

export interface Setting {
  readonly name: string
  /** Secrets are read as `Redacted` and never printed. */
  readonly secret: boolean
  readonly components: ReadonlyArray<Component>
  readonly description: string
  readonly default?: string
}

/**
 * Every setting and secret the pi-cloud servers read, in one place. The config schemas are built from these
 * names, `pi-cloud config` reports on them, and `secrets.example.yaml` lists the secret ones.
 */
export const SETTINGS: ReadonlyArray<Setting> = [
  // Control plane
  { name: "PORT", secret: false, components: ["control-plane", "runner"], description: "Port to listen on", default: "8787 (runner host: 8788)" },
  { name: "HOST", secret: false, components: ["control-plane", "runner"], description: "Interface to listen on", default: "127.0.0.1" },
  { name: "DATA_DIR", secret: false, components: ["control-plane", "runner"], description: "SQLite state, bindings and local sandboxes", default: ".data" },
  { name: "PUBLIC_URL", secret: false, components: ["control-plane"], description: "URL runners use to reach the control plane", default: "http://HOST:PORT" },
  { name: "RUNNER_URL", secret: false, components: ["control-plane"], description: "Runner host wake endpoint, for split deployments" },
  { name: "PI_CLOUD_API_KEYS", secret: true, components: ["control-plane"], description: "Comma-separated API keys; unset accepts every client" },
  { name: "PI_CLOUD_RUNNER_SECRET", secret: true, components: ["control-plane", "runner"], description: "Shared secret between control plane and runners" },
  { name: "PI_CLOUD_MODEL", secret: false, components: ["control-plane"], description: "Model for sessions created by triggers and sources", default: "anthropic/claude-opus-5-5" },
  { name: "GITHUB_WEBHOOK_SECRET", secret: true, components: ["control-plane"], description: "Enables the GitHub trigger" },
  { name: "GITHUB_MENTION", secret: false, components: ["control-plane"], description: "Only react to GitHub activity mentioning this, e.g. @pi" },
  { name: "GITHUB_SANDBOX_PROVIDER", secret: false, components: ["control-plane"], description: "Sandbox provider for the repository sandbox of GitHub-triggered sessions", default: "local" },
  { name: "SLACK_SIGNING_SECRET", secret: true, components: ["control-plane"], description: "Enables the Slack source (with SLACK_BOT_TOKEN)" },
  { name: "SLACK_BOT_TOKEN", secret: true, components: ["control-plane"], description: "Posts the agent's replies to Slack" },
  // Runner
  { name: "CONTROL_PLANE_URL", secret: false, components: ["runner"], description: "Control plane to attach to (runner host)" },
  { name: "ANTHROPIC_API_KEY", secret: true, components: ["runner"], description: "Anthropic models" },
  { name: "OPENAI_API_KEY", secret: true, components: ["runner"], description: "OpenAI models" },
  { name: "GITHUB_TOKEN", secret: true, components: ["runner"], description: "GitHub tools (comment, open pull requests); list it in SANDBOX_SECRETS to also clone and push" },
  { name: "SANDBOX_SECRETS", secret: false, components: ["runner"], description: "Comma-separated secret names sandbox templates may request, each read like any other secret" },
  { name: "SANDBOX_TEMPLATES_FILE", secret: false, components: ["runner"], description: "JSON file of sandbox templates by name, available to every session" }
]

/** Model provider credentials, by the variable name pi-ai looks them up under. */
export const MODEL_CREDENTIALS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const
