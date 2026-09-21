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
 * Antigravity Native Pipeline Workflow
 * Orchestrates multi-agent execution across Gemini Pro, Gemini Flash, and Claude models.
 */
export default async function runPipeline(args = {}) {
  const { milestone, tier = 'balanced', task, gates = 'standard' } = args;

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
        label: 'planner:gemini-pro',
        phase: 'Plan',
        model: tier === 'economy' ? 'gemini-2.5-flash' : 'gemini-2.5-pro'
      }
    );
  });

  // Optional Phase 2: Plan Critique (Premium tier)
  if (tier === 'premium') {
    await phase('Critique', async () => {
      return await agent(
        `Critique the plan in .pipeline/plan.md with the skepticism of a Principal Staff Engineer.
Verify edge cases, security implications, data consistency, and architectural trade-offs.
Update .pipeline/plan.md with fixes.`,
        {
          label: 'critique:gemini-pro',
          phase: 'Critique',
          model: 'gemini-2.5-pro'
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
        label: 'builder:gemini-pro',
        phase: 'Build',
        model: tier === 'economy' ? 'gemini-2.5-flash' : 'gemini-2.5-pro'
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
        label: 'reviewer:gemini-pro',
        phase: 'Review',
        model: tier === 'economy' ? 'gemini-2.5-flash' : 'gemini-2.5-pro'
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
          label: 'committer:gemini-flash',
          phase: 'Commit',
          model: 'gemini-2.5-flash'
        }
      );
    });
  }

  return { ok: true, milestone, tier };
}
