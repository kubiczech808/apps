import { AbiParameters, Hash } from 'ox';
/** Derives a withdrawal sender tag from its sender and transaction hash. @internal */
export function from(options) {
    const { sender, transactionHash } = options;
    return Hash.keccak256(AbiParameters.encodePacked(['address', 'bytes32'], [sender, transactionHash]));
}
//# sourceMappingURL=WithdrawalSenderTag.js.map