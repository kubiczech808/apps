import { ZoneId } from 'ox/tempo';
import { tempo } from '../../chains/definitions/tempo.js';
import { tempoModerato } from '../../chains/definitions/tempoModerato.js';
import { defineChain } from '../../utils/chain/defineChain.js';
import { chainConfig } from '../chainConfig.js';
import * as Addresses from './Addresses.js';
export function getPortalAddress(chainId, zoneId) {
    const address = Addresses.portal[chainId]?.[zoneId];
    if (!address)
        throw new Error(`No portal address configured for zone ${zoneId} on chain ${chainId}.`);
    return address;
}
const overrides = {
    [tempoModerato.id]: {
        1: {
            contracts: {
                messenger: {
                    [tempoModerato.id]: {
                        address: Addresses.messenger[tempoModerato.id][1],
                    },
                },
                portal: {
                    [tempoModerato.id]: {
                        address: Addresses.portal[tempoModerato.id][1],
                    },
                },
            },
            name: 'Zone E',
            rpcUrl: 'https://rpc-zone-e.testnet.tempo.xyz',
        },
        6: {
            name: 'Zone A',
            rpcUrl: 'https://rpc-zone-a.testnet.tempo.xyz',
        },
        7: {
            name: 'Zone B',
            rpcUrl: 'https://rpc-zone-b.testnet.tempo.xyz',
        },
    },
};
export const zone = /*#__PURE__*/ from({
    sourceId: tempo.id,
    rpcHost: 'tempo.xyz',
});
export const zoneModerato = /*#__PURE__*/ from({
    sourceId: tempoModerato.id,
    rpcHost: 'tempoxyz.dev',
});
/** Creates a zone chain factory for a given Tempo network. */
export function from(options) {
    return (id) => {
        const chainId = ZoneId.toChainId(id);
        const paddedId = String(id).padStart(3, '0');
        const override = overrides[options.sourceId]?.[id];
        return defineChain({
            ...chainConfig,
            ...(override?.contracts ? { contracts: override.contracts } : {}),
            id: chainId,
            name: override?.name ?? `Tempo Zone ${paddedId}`,
            nativeCurrency: {
                name: 'USD',
                symbol: 'USD',
                decimals: 6,
            },
            rpcUrls: {
                default: {
                    http: [
                        override?.rpcUrl ??
                            `https://rpc-zone-${paddedId}.${options.rpcHost}`,
                    ],
                },
            },
            sourceId: options.sourceId,
            supportsTransactionReplacementDetection: false,
        });
    };
}
//# sourceMappingURL=zone.js.map