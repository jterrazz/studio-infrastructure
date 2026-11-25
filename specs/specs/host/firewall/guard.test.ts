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

// outside: `nft list table` prints each chain as `chain <name> {`, its rules, then `}`, and a
// counter with what it counted so far.
function rulesOf(table: string, chain: string): string[] {
    const lines = table.split('\n').map((line) => line.trim());
    const start = lines.indexOf(`chain ${chain} {`);
    if (start === -1) {
        return [];
    }
    const end = lines.indexOf('}', start);

    return lines
        .slice(start + 1, end)
        .filter((line) => line !== '')
        .map((line) => line.replace(/ counter packets \d+ bytes \d+/u, ' counter'));
}

describe('guard', () => {
    test('the node takes connections from the tailnet on its declared ports alone, and none from the bridge', async () => {
        // Given - the nftables guard roles/security installs, as the kernel holds it, and the node's bridge address
        const { interface: bridge, tailnetTcp } = guardDefaults();
        const table = await onHost(['nft', 'list', 'table', 'inet', 'studio_guard']);
        const address = await onHost(['ip', '-4', '-o', 'addr', 'show', 'dev', bridge]);
        const nodeIp = /\binet (?<ip>[\d.]+)\//u.exec(address.stdout)?.groups?.ip;
        const input = rulesOf(table.stdout, 'input');
        const on = (prefix: string): string[] => input.filter((rule) => rule.startsWith(prefix));

        // Then - the tailnet's ports then a drop, NodePorts dropped, the bridge closed but to the host and DHCP, and the tailnet's API traffic sent to the node address (docs/decisions/006-the-host-has-no-public-inbound-path.md)
        expect({
            bridgeLast: on(`iif "${bridge}"`).at(-1),
            code: table.code,
            nodePorts: on(`iif "${bridge}"`).filter((rule) => rule.includes('30000-32767')),
            tailnet: on('iifname "tailscale0"'),
            tailnetApi: rulesOf(table.stdout, 'tailnet_api').filter(
                (rule) => !rule.startsWith('type '),
            ),
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
            tailnetApi: [`iifname "tailscale0" tcp dport 6443 counter dnat ip to ${nodeIp}`],
        });
    });
});
