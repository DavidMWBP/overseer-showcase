import { describe, expect, it } from 'vitest';
import { createBoardResponseGate } from './boardResponse';

describe('board response order', () => {
  it('ignores an older answer after a newer request has already landed', () => {
    const applyAnswer = createBoardResponseGate();
    const applied: string[] = [];

    expect(applyAnswer(2, () => applied.push('newer'))).toBe(true);
    expect(applyAnswer(1, () => applied.push('older'))).toBe(false);
    expect(applied).toEqual(['newer']);
  });
});
