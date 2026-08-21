import { describe, it, expect } from 'vitest';
import { DEFAULT_POST_PROCESS } from '../src/app/types/studio';

describe('Studio Types & Config Defaults', () => {
  it('should have valid default post-process parameters', () => {
    expect(DEFAULT_POST_PROCESS.brightness).toBe(100);
    expect(DEFAULT_POST_PROCESS.contrast).toBe(100);
    expect(DEFAULT_POST_PROCESS.saturation).toBe(100);
    expect(DEFAULT_POST_PROCESS.shadowEnable).toBe(false);
    expect(DEFAULT_POST_PROCESS.scale).toBe(1.0);
    expect(DEFAULT_POST_PROCESS.positionX).toBe(0);
    expect(DEFAULT_POST_PROCESS.positionY).toBe(0);
    expect(DEFAULT_POST_PROCESS.presetFilter).toBe('none');
  });
});
