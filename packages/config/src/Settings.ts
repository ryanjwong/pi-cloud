export type Component = "control-plane" | "runner"

export interface Setting {
  readonly name: string
  readonly secret: boolean
  readonly components: ReadonlyArray<Component>
  readonly description: string
  readonly default?: string
}

export const SETTINGS: ReadonlyArray<Setting> = [
  { name: "PI_CLOUD_CONFIG", secret: false, components: ["control-plane", "runner"], description: "Server config file (pi-cloud.config.json or .ts) or inline JSON; environment variables override it" },
  { name: "PORT", secret: false, components: ["control-plane"], description: "Port to listen on", default: "8787" },
  { name: "HOST", secret: false, components: ["control-plane"], description: "Interface to listen on", default: "127.0.0.1" },
  { name: "DATA_DIR", secret: false, components: ["control-plane", "runner"], description: "SQLite state, bindings, local sandboxes, and the generated admin-token and credential-key on loopback", default: ".data" },
  { name: "PUBLIC_URL", secret: false, components: ["control-plane"], description: "URL runners use to reach the control plane", default: "http://HOST:PORT" },
  { name: "PI_CLOUD_API_KEYS", secret: true, components: ["control-plane"], description: "Comma-separated admin API keys (scoped keys go in PI_CLOUD_CONFIG auth.keys); without any key on loopback the server writes DATA_DIR/admin-token" },
  { name: "PI_CLOUD_RUNNER_SECRET", secret: true, components: ["control-plane", "runner"], description: "Shared secret runners use to reach the control plane; required when they run apart (generated per start in the all-in-one server)" },
  { name: "PI_CLOUD_CREDENTIAL_KEY", secret: true, components: ["control-plane"], description: "Comma-separated keys for stored model credentials (AES-256-GCM): the first encrypts, all decrypt; generated into DATA_DIR/credential-key on loopback" },
  { name: "PI_CLOUD_MODEL", secret: false, components: ["control-plane"], description: "Model for sessions created by triggers and sources", default: "anthropic/claude-opus-5-5" },
  { name: "GITHUB_APP_ID", secret: false, components: ["control-plane"], description: "GitHub App: sessions get hour-long installation tokens for their repository as GITHUB_TOKEN (with GITHUB_APP_PRIVATE_KEY)" },
  { name: "GITHUB_APP_PRIVATE_KEY", secret: true, components: ["control-plane"], description: "The GitHub App's private key (PEM); never leaves the control plane" },
  { name: "GITHUB_WEBHOOK_SECRET", secret: true, components: ["control-plane"], description: "Enables the GitHub trigger" },
  { name: "GITHUB_MENTION", secret: false, components: ["control-plane"], description: "Only react to GitHub activity mentioning this as a whole word, e.g. @pi" },
  { name: "GITHUB_ALLOWED_ASSOCIATIONS", secret: false, components: ["control-plane"], description: "Comma-separated author associations the GitHub trigger reacts to", default: "OWNER,MEMBER,COLLABORATOR" },
  { name: "GITHUB_SANDBOX_PROVIDER", secret: false, components: ["control-plane"], description: "Sandbox provider of the built-in github template used by GitHub-triggered sessions", default: "docker (Cloudflare: daytona)" },
  { name: "SLACK_SIGNING_SECRET", secret: true, components: ["control-plane"], description: "Enables the Slack source (with SLACK_BOT_TOKEN)" },
  { name: "SLACK_BOT_TOKEN", secret: true, components: ["control-plane"], description: "Posts the agent's replies to Slack" },
  { name: "SLACK_ALLOWED_USERS", secret: false, components: ["control-plane"], description: "Comma-separated Slack user ids the agent answers (nobody by default)" },
  { name: "SLACK_ALLOWED_CHANNELS", secret: false, components: ["control-plane"], description: "Comma-separated Slack channel ids whose members the agent answers (none by default)" },
  { name: "CONTROL_PLANE_URL", secret: false, components: ["runner"], description: "Control plane the runner host connects out to for wake requests (required); runners need no inbound port" },
  { name: "ANTHROPIC_API_KEY", secret: true, components: ["runner"], description: "Anthropic models" },
  { name: "OPENAI_API_KEY", secret: true, components: ["runner"], description: "OpenAI models" },
  { name: "GITHUB_TOKEN", secret: true, components: ["runner"], description: "GitHub token when there is no GitHub App; list it in SANDBOX_SECRETS so templates and the GitHub tools can use it" },
  { name: "SANDBOX_SECRETS", secret: false, components: ["runner"], description: "Comma-separated secret names sandbox templates may request, each read like any other secret" },
  { name: "SANDBOX_TEMPLATES_FILE", secret: false, components: ["control-plane"], description: "JSON file of sandbox templates by name, merged over the config file's" },
  { name: "PI_CLOUD_UNSAFE_LOCAL_SANDBOX", secret: false, components: ["control-plane", "runner"], description: "Install the local sandbox provider, which runs commands on the host without isolation, and make it the scratch template", default: "false" },
  { name: "DAYTONA_API_KEY", secret: true, components: ["runner"], description: "Daytona sandboxes (templates with provider \"daytona\")" }
]

export const MODEL_CREDENTIALS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const
