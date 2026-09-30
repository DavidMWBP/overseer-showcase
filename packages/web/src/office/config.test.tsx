import { describe, expect, it } from 'vitest';
import { agentLabel } from './config';

describe('agentLabel', () => {
  it('shows the model the harness resolved when it has reported one, over the configured model', () => {
    expect(agentLabel({ harness: 'claude', model: 'sonnet', resolved_model: 'claude-opus-5', bead_id: 'ov-3', role: 'worker' }))
      .toBe('claude · claude-opus-5 · ov-3');
  });

  it('shows the configured model until the harness reports a resolved one', () => {
    expect(agentLabel({ harness: 'claude', model: 'opus', resolved_model: null, bead_id: 'ov-3', role: 'worker' }))
      .toBe('claude · opus · ov-3');
  });

  it('shows no model segment at all when neither is known, never "no model"', () => {
    const worker = agentLabel({ harness: 'claude', model: null, resolved_model: null, bead_id: 'ov-3', role: 'worker' });
    expect(worker).toBe('claude · ov-3');
    expect(worker).not.toContain('no model');
    const orchestrator = agentLabel({ harness: 'claude', model: null, resolved_model: null, bead_id: null, role: 'orchestrator' });
    expect(orchestrator).toBe('claude · orchestrator');
    expect(orchestrator).not.toContain('no model');
  });
});
