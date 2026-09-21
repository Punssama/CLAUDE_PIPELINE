export const meta = {
  name: 'ai-pipeline',
  description: 'AI multi-agent coding pipeline for Antigravity & Claude: Plan -> Build -> Quality Gates & Review -> Commit',
  phases: [
    { title: 'Plan', detail: 'Generate structured milestone plan with test matrix and AC mapping' },
    { title: 'Critique', detail: 'Adversarial staff engineer review of plan (Premium tier)' },
    { title: 'Build', detail: 'Test-driven implementation of tasks and automated quality checks' },
    { title: 'Review', detail: 'Read-only code review verifying requirements and edge cases' },
    { title: 'Commit', detail: 'Clean atomic commit with milestone summary' }
  ]
};

/**
 * Model and reasoning effort mapping per tier for Antigravity & Gemini:
 * - economy: Gemini 3.8 Flash with medium effort across all stages.
 * - balanced: Gemini 3.1 Pro with high effort across all stages.
 * - premium: Plan with Gemini 3.8 Flash (max effort), Build & Review with Gemini 3.1 Pro (max effort), Commit with Gemini 3.7 Flash.
 */
const TIER_CONFIG = {
  economy: {
    plan: { model: 'gemini-3.8-flash', effort: 'medium' },
    critique: null,
    build: { model: 'gemini-3.8-flash', effort: 'medium' },
    review: { model: 'gemini-3.8-flash', effort: 'medium' },
    commit: { model: 'gemini-3.8-flash', effort: 'medium' }
  },
  balanced: {
    plan: { model: 'gemini-3.1-pro', effort: 'high' },
    critique: null,
    build: { model: 'gemini-3.1-pro', effort: 'high' },
    review: { model: 'gemini-3.1-pro', effort: 'high' },
    commit: { model: 'gemini-3.1-pro', effort: 'high' }
  },
  premium: {
    plan: { model: 'gemini-3.8-flash', effort: 'max' },
    critique: { model: 'gemini-3.1-pro', effort: 'max' },
    build: { model: 'gemini-3.1-pro', effort: 'max' },
    review: { model: 'gemini-3.1-pro', effort: 'max' },
    commit: { model: 'gemini-3.7-flash', effort: 'high' }
  }
};

/**
 * Antigravity Native Pipeline Workflow
 * Orchestrates multi-agent execution across Gemini 3.1 Pro, Gemini 3.8 Flash, and Gemini 3.7 Flash.
 */
export default async function runPipeline(args = {}) {
  const { milestone, tier = 'balanced', task, gates = 'standard' } = args;
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG.balanced;

  // Phase 1: Plan
  const planResult = await phase('Plan', async () => {
    return await agent(
      `You are an expert software architect planning milestone ${milestone || 'M1'}.
Task: ${task || 'Implement milestone tasks based on SPEC.md and ROADMAP.md'}
Tier: ${tier}. Quality gates: ${gates}.
Explore the codebase, verify dependencies, and generate a complete .pipeline/plan.md with:
1. Clear goal and non-goals
2. Assumptions
3. Granular tasks with AC mapping
4. Test matrix
5. Verified test command`,
      {
        label: `planner:${cfg.plan.model}`,
        phase: 'Plan',
        model: cfg.plan.model,
        effort: cfg.plan.effort
      }
    );
  });

  // Optional Phase 2: Plan Critique (Premium tier)
  if (tier === 'premium' && cfg.critique) {
    await phase('Critique', async () => {
      return await agent(
        `Critique the plan in .pipeline/plan.md with the skepticism of a Principal Staff Engineer.
Verify edge cases, security implications, data consistency, and architectural trade-offs.
Update .pipeline/plan.md with fixes.`,
        {
          label: `critique:${cfg.critique.model}`,
          phase: 'Critique',
          model: cfg.critique.model,
          effort: cfg.critique.effort
        }
      );
    });
  }

  // Phase 3: Build
  const buildResult = await phase('Build', async () => {
    return await agent(
      `You are a senior full-stack engineer implementing milestone ${milestone || 'M1'}.
Follow .pipeline/plan.md strictly. Write tests first.
Ensure every acceptance criterion has explicit test coverage.
Run test, lint, type-check, and build commands before completing.`,
      {
        label: `builder:${cfg.build.model}`,
        phase: 'Build',
        model: cfg.build.model,
        effort: cfg.build.effort
      }
    );
  });

  // Phase 4: Review
  const reviewResult = await phase('Review', async () => {
    return await agent(
      `You are a staff code reviewer. Read-only review of changes against .pipeline/plan.md.
Check proof of ACs, correctness, edge cases, resource leaks, and test quality.
Write findings to .pipeline/review.md ending with VERDICT: PASS or VERDICT: FAIL.`,
      {
        label: `reviewer:${cfg.review.model}`,
        phase: 'Review',
        model: cfg.review.model,
        effort: cfg.review.effort
      }
    );
  });

  // Phase 5: Commit (only if review passed)
  if (reviewResult && (!reviewResult.verdict || reviewResult.verdict === 'PASS')) {
    await phase('Commit', async () => {
      return await agent(
        `Commit the verified changes for milestone ${milestone || 'M1'}.
Create a clean, descriptive git commit message summarizing the milestone and verified ACs.`,
        {
          label: `committer:${cfg.commit.model}`,
          phase: 'Commit',
          model: cfg.commit.model,
          effort: cfg.commit.effort
        }
      );
    });
  }

  return { ok: true, milestone, tier };
}
