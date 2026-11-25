import { describe, expect, test } from 'vitest';

import { onHost } from '../__setup__/shell.ts';

// outside: OrbStack publishes a VM's wildcard listeners on every interface of the Mac, and no
// listener bound to one address.
const WILDCARD_HOSTS = new Set(['*', '0.0.0.0', '[::]']);

describe('wildcard', () => {
    test('no TCP listener on the node takes every address but sshd, whose port the Mac holds itself', async () => {
        // Given - the node's TCP listeners, as the kernel holds them
        const listeners = await onHost(['ss', '-ltnH']);
        const wildcard = listeners.stdout
            .split('\n')
            .map((line) => line.trim().split(/\s+/u)[3] ?? '')
            .filter((local) => WILDCARD_HOSTS.has(local.slice(0, local.lastIndexOf(':'))));
        const found = [...new Set(wildcard)].toSorted();

        // Then - sshd alone, on IPv4 (docs/decisions/006-the-host-has-no-public-inbound-path.md)
        expect({ code: listeners.code, wildcard: found }).toStrictEqual({
            code: 0,
            wildcard: ['0.0.0.0:22'],
        });
    });
});
