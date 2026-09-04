// @vitest-environment node
/**
 * Which reference an indicative figure may cite — and when it may cite none.
 * S → projected (2 × fx); S+1 → the live fx; anything else → nothing.
 */
import { describe, it, expect } from 'vitest';
import { resolveReferenceBasis, SPLIT_MULTIPLIER } from './referenceBasis';

describe('resolveReferenceBasis', () => {
  it('while the mandate split is still running the reference is the projected next-split price', () => {
    expect(resolveReferenceBasis({ mandateSplit: 8, currentSplit: 8, fx: 0.128 }))
      .toEqual({ basis: 'projected_next_split', rate: 0.128 * SPLIT_MULTIPLIER });
  });

  it('one split later the live fx IS the reference', () => {
    expect(resolveReferenceBasis({ mandateSplit: 8, currentSplit: 9, fx: 0.256 }))
      .toEqual({ basis: 'current_split', rate: 0.256 });
  });

  it('two splits later there is nothing honest to quote', () => {
    expect(resolveReferenceBasis({ mandateSplit: 8, currentSplit: 10, fx: 0.5 })).toBeNull();
  });

  it('a mandate for a future split has no reference yet either', () => {
    expect(resolveReferenceBasis({ mandateSplit: 9, currentSplit: 8, fx: 0.128 })).toBeNull();
  });

  it('no fx, no split → null, never a zero rate', () => {
    expect(resolveReferenceBasis({ mandateSplit: 8, currentSplit: 8, fx: 0 })).toBeNull();
    expect(resolveReferenceBasis({ mandateSplit: 8, currentSplit: null, fx: 0.128 })).toBeNull();
    expect(resolveReferenceBasis({ mandateSplit: null, currentSplit: 8, fx: 0.128 })).toBeNull();
    expect(resolveReferenceBasis({ mandateSplit: 8, currentSplit: 8, fx: undefined })).toBeNull();
  });
});
