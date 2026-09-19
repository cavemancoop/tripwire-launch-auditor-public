import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, parseRedisUrl } from '../src/queues';

describe('parseRedisUrl', () => {
  it('extracts host, port and password', () => {
    expect(parseRedisUrl('redis://:secret@127.0.0.1:6380')).toEqual({
      host: '127.0.0.1',
      port: 6380,
      password: 'secret',
    });
  });

  it('defaults the port to 6379 and omits an absent password', () => {
    expect(parseRedisUrl('redis://localhost')).toEqual({
      host: 'localhost',
      port: 6379,
    });
  });
});

describe('QUEUE_NAMES', () => {
  it('registers every pipeline queue', () => {
    expect(Object.values(QUEUE_NAMES).sort()).toEqual(
      ['assess', 'commits', 'deepdive', 'features', 'metabolism', 'outcomes', 'watcher'].sort(),
    );
  });
});
