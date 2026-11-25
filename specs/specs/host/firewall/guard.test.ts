import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import { REPOSITORY_ROOT } from '../../__setup__/kubectl.ts';
import { onHost } from '../__setup__/shell.ts';

// outside: the guard's settings, where roles/security reads them.
function guardDefaults(): { interface: string; tailnetTcp: number[] } {
    const defaults: unknown = parse(
        readFileSync(`${REPOSITORY_ROOT}src/ansible/roles/security/defaults/main.yml`, 'utf8'),
    );
    const read = (key: string): unknown =>
        typeof defaults === 'object' && defaults !== null ? Reflect.get(defaults, key) : undefined;
    const bridge = read('security_guard_interface');
    const tailnetTcp = read('security_guard_tailnet_tcp');
    if (typeof bridge !== 'string' || !Array.isArray(tailnetTcp)) {
        throw new TypeError('roles/security/defaults/main.yml lacks the guard settings');
    }

    return { interface: bridge, tailnetTcp: tailnetTcp.map(Number) };
}

type Reach = { ipv4: string; ipv6: string };

// value: 3 s, since a reset answers at once and only a dropped packet waits that long.
async function dial(address: string, port: number): Promise<string> {
    const outcome = await onHost(['timeout', '3', 'bash'], `exec 3<>/dev/tcp/${address}/${port}\n`);
    if (outcome.code === 0) {
        return 'connects';
    }
    if (outcome.stderr.includes('Connection refused')) {
        return 'refused';
    }

    return outcome.code === 124 ? 'times out' : `exit ${outcome.code}`;
}

describe('guard', () => {
    test('the node takes connections from the tailnet on its declared ports alone, and none from the bridge', async () => {
        // Given - the nftables guard roles/security installs, as the kernel holds it
        const table = await onHost(['nft', 'list', 'table', 'inet', 'studio_guard']);
        const rules = table.stdout.split('\n').map((line) => line.trim());
        const { interface: bridge, tailnetTcp } = guardDefaults();
        const on = (prefix: string): string[] => rules.filter((rule) => rule.startsWith(prefix));

        // Then - the tailnet's ports then a drop, NodePorts dropped, and the bridge closed but to the host and DHCP (docs/decisions/006-the-host-has-no-public-inbound-path.md)
        expect({
            bridgeLast: on(`iif "${bridge}"`).at(-1),
            code: table.code,
            nodePorts: on(`iif "${bridge}"`).filter((rule) => rule.includes('30000-32767')),
            tailnet: on('iifname "tailscale0"'),
        }).toStrictEqual({
            bridgeLast: `iif "${bridge}" drop`,
            code: 0,
            nodePorts: [
                `iif "${bridge}" tcp dport 30000-32767 drop`,
                `iif "${bridge}" udp dport 30000-32767 drop`,
            ],
            tailnet: [
                `iifname "tailscale0" tcp dport { ${tailnetTcp.join(', ')} } accept`,
                'iifname "tailscale0" drop',
            ],
        });
    });

    test('a dual-stack listener refuses a connection from [::1] and takes one from 127.0.0.1', async () => {
        // Given - every port the node listens on for both families, the ones OrbStack forwards from the Mac's interfaces
        const listening = await onHost(['ss', '-ltnH']);
        const ports = [
            ...new Set(
                listening.stdout
                    .split('\n')
                    .map((line) => line.trim().split(/\s+/u)[3] ?? '')
                    .filter((local) => local.startsWith('*:'))
                    .map((local) => Number(local.slice(2))),
            ),
        ].toSorted((a, b) => a - b);

        // When - each port is dialled over IPv6 loopback, as OrbStack's forward does, then over IPv4 loopback
        const outcomes = Object.fromEntries(
            await Promise.all(
                ports.map(async (port): Promise<[string, Reach]> => [
                    String(port),
                    { ipv4: await dial('127.0.0.1', port), ipv6: await dial('::1', port) },
                ]),
            ),
        );

        // Then - the guard resets every [::1] connection and leaves IPv4 loopback open (docs/decisions/006-the-host-has-no-public-inbound-path.md)
        expect({ code: listening.code, listens: ports.length > 0, outcomes }).toStrictEqual({
            code: 0,
            listens: true,
            outcomes: Object.fromEntries(
                ports.map((port): [string, Reach] => [
                    String(port),
                    { ipv4: 'connects', ipv6: 'refused' },
                ]),
            ),
        });
    });
});
