import { describe, it, expect } from 'bun:test';
import { signHotaudioPayload } from '../src/signer';

describe('signHotaudioPayload', () => {
  it('matches ground-truth signature vector at frozen timestamp t=1787330000', () => {
    const payload = JSON.stringify({
      tid: '17343',
      pid: '21031',
      key: 'dvmjckbbc1e9trv2srbgzmwx00',
      tick: '1VmCFHEA7s8l8MuDgHU7D2eHX0Dia',
      first: -1,
    });

    const sig = signHotaudioPayload(payload, 1787330000);
    expect(sig).toBe('9:6a887dd0210c4f28909ac87900909aca');
  });

  it('generates valid 9: prefixed 34-char signature using current time by default', () => {
    const payload = JSON.stringify({ tid: '123', pid: '456', key: 'test', tick: 'abc', first: -1 });
    const sig = signHotaudioPayload(payload);
    expect(sig).toMatch(/^9:[0-9a-f]{32}$/);
  });
});
