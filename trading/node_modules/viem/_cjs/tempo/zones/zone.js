"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zoneModerato = exports.zone = void 0;
exports.getPortalAddress = getPortalAddress;
exports.from = from;
const tempo_1 = require("ox/tempo");
const tempo_js_1 = require("../../chains/definitions/tempo.js");
const tempoModerato_js_1 = require("../../chains/definitions/tempoModerato.js");
const defineChain_js_1 = require("../../utils/chain/defineChain.js");
const chainConfig_js_1 = require("../chainConfig.js");
const Addresses = require("./Addresses.js");
function getPortalAddress(chainId, zoneId) {
    const address = Addresses.portal[chainId]?.[zoneId];
    if (!address)
        throw new Error(`No portal address configured for zone ${zoneId} on chain ${chainId}.`);
    return address;
}
const overrides = {
    [tempoModerato_js_1.tempoModerato.id]: {
        1: {
            contracts: {
                messenger: {
                    [tempoModerato_js_1.tempoModerato.id]: {
                        address: Addresses.messenger[tempoModerato_js_1.tempoModerato.id][1],
                    },
                },
                portal: {
                    [tempoModerato_js_1.tempoModerato.id]: {
                        address: Addresses.portal[tempoModerato_js_1.tempoModerato.id][1],
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
exports.zone = from({
    sourceId: tempo_js_1.tempo.id,
    rpcHost: 'tempo.xyz',
});
exports.zoneModerato = from({
    sourceId: tempoModerato_js_1.tempoModerato.id,
    rpcHost: 'tempoxyz.dev',
});
function from(options) {
    return (id) => {
        const chainId = tempo_1.ZoneId.toChainId(id);
        const paddedId = String(id).padStart(3, '0');
        const override = overrides[options.sourceId]?.[id];
        return (0, defineChain_js_1.defineChain)({
            ...chainConfig_js_1.chainConfig,
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