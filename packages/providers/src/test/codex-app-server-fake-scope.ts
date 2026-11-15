/**
 * The fake app-server's answers to the config and plugin reads that scope a node's thread:
 * `config/read`, `plugin/installed` and `plugin/read`.
 */
import type { ConfigReadResponse } from '../codex/protocol/v2/ConfigReadResponse';
import type { PluginInstalledResponse } from '../codex/protocol/v2/PluginInstalledResponse';
import type { PluginReadResponse } from '../codex/protocol/v2/PluginReadResponse';
import type { PluginSummary } from '../codex/protocol/v2/PluginSummary';

export function configReadResponse(servers: string[]): ConfigReadResponse {
  return {
    config: {
      model: null,
      review_model: null,
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: null,
      model_provider: null,
      approval_policy: null,
      approvals_reviewer: null,
      sandbox_mode: null,
      sandbox_workspace_write: null,
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      web_search: null,
      tools: null,
      instructions: null,
      developer_instructions: null,
      compact_prompt: null,
      model_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      service_tier: null,
      analytics: null,
      apps: null,
      browser_use: null,
      computer_use: null,
      desktop: null,
      mcp_servers: Object.fromEntries(servers.map(name => [name, { command: name }])),
    },
    origins: {},
    layers: null,
  };
}

const FAKE_MARKETPLACE_PATH = '/home/user/.codex/marketplaces/fixture/marketplace.json';

function pluginSummary(id: string): PluginSummary {
  return {
    id,
    remotePluginId: null,
    version: null,
    localVersion: null,
    name: id.split('@')[0],
    shareContext: null,
    source: { type: 'local', path: '/home/user/.codex/plugins/fixture' },
    installed: true,
    installedAt: null,
    enabled: true,
    installPolicy: 'AVAILABLE',
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: 'ON_INSTALL',
    availability: 'AVAILABLE',
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: null,
    keywords: [],
  };
}

export function pluginInstalledResponse(
  plugins: Record<string, string[]>
): PluginInstalledResponse {
  return {
    marketplaces: [
      {
        name: 'fixture',
        path: FAKE_MARKETPLACE_PATH,
        interface: null,
        plugins: Object.keys(plugins).map(pluginSummary),
      },
    ],
    marketplaceLoadErrors: [],
  };
}

export function pluginReadResponse(name: string, mcpServers: string[]): PluginReadResponse {
  return {
    plugin: {
      marketplaceName: 'fixture',
      marketplacePath: FAKE_MARKETPLACE_PATH,
      summary: pluginSummary(`${name}@fixture`),
      shareUrl: null,
      description: null,
      skills: [],
      onboardingSkill: null,
      hooks: [],
      apps: [],
      appTemplates: [],
      mcpServers,
      scheduledTasks: null,
    },
  };
}
