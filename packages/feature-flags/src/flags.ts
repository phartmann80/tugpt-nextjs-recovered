export interface FeatureFlagRule {
  allowedRoles?: string[];
  allowedOrgIds?: string[];
  rolloutPercentage?: number; // 0 to 100
  minimumPlan?: 'free' | 'pro' | 'enterprise';
}

export interface FeatureFlagEvaluatorOptions {
  organizationId?: string;
  userRole?: string;
  plan?: string;
}

export class FeatureFlagService {
  private flags: Map<string, { isEnabled: boolean; rules?: FeatureFlagRule }> = new Map();

  constructor() {
    // Default system flags
    this.flags.set('whatsapp_integration', { isEnabled: false });
    this.flags.set('voice_receptionist', { isEnabled: true });
    this.flags.set('langdock_orchestrator', { isEnabled: true });
    this.flags.set('mastra_orchestrator', { isEnabled: true });
    this.flags.set('image_generation', { isEnabled: false }); // Beta flag
    this.flags.set('video_generation', { isEnabled: false }); // Beta flag
  }

  public setFlag(key: string, isEnabled: boolean, rules?: FeatureFlagRule): void {
    this.flags.set(key, { isEnabled, rules });
  }

  public isEnabled(key: string, options: FeatureFlagEvaluatorOptions = {}): boolean {
    const flag = this.flags.get(key);
    if (!flag) return false;
    if (!flag.isEnabled) return false;

    const { rules } = flag;
    if (!rules) return true;

    // Evaluate allowed roles
    if (rules.allowedRoles && options.userRole) {
      if (!rules.allowedRoles.includes(options.userRole)) {
        return false;
      }
    }

    // Evaluate allowed orgs
    if (rules.allowedOrgIds && options.organizationId) {
      if (!rules.allowedOrgIds.includes(options.organizationId)) {
        return false;
      }
    }

    return true;
  }
}

export const featureFlagService = new FeatureFlagService();
